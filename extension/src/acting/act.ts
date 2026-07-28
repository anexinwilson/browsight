/**
 * Acting: perform one bounded action on the page, wait for it to settle, then report a typed verdict
 * and a structural diff. Reference re-resolution lives in `./resolve.ts` and the quiet-window wait in
 * `./settle.ts`; this module orchestrates them.
 */
import type { Action, Diff, Ref, Sentinel, Verdict } from "@browsight/shared";
import { buildSnapshot } from "../perception/snapshot.ts";
import { computeDiff, selectVerdict } from "./diff.ts";
import { rememberSnapshot, rememberedSnapshot, resolveRef } from "./resolve.ts";
import {
  type ScrollDirection,
  findScrollTarget,
  observeSemanticGrowth,
  scrollActiveSurface,
  scrollSurface,
} from "./scroll.ts";
import { settle } from "./settle.ts";

export interface ActResult {
  readonly verdict: Verdict;
  readonly diff: Diff;
  readonly refs: Ref[];
  readonly sentinel?: Sentinel;
}

function realmOf(el: Element): typeof globalThis {
  return (el.ownerDocument.defaultView ?? globalThis) as unknown as typeof globalThis;
}

function tagName(el: Element): string {
  return el.tagName.toLowerCase();
}

function isTextControl(el: Element): el is HTMLInputElement | HTMLTextAreaElement {
  const tag = tagName(el);
  return tag === "input" || tag === "textarea";
}

function isSelectControl(el: Element): el is HTMLSelectElement {
  return tagName(el) === "select";
}

export function fillValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const realm = realmOf(el);
  const proto =
    tagName(el) === "textarea"
      ? realm.HTMLTextAreaElement.prototype
      : realm.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  el.focus();
  el.dispatchEvent(
    new realm.InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      composed: true,
      inputType: "insertText",
      data: value,
    }),
  );
  if (setter) {
    setter.call(el, value);
  } else {
    el.value = value;
  }
  if (typeof el.setSelectionRange === "function") {
    el.setSelectionRange(value.length, value.length);
  }
  el.dispatchEvent(
    new realm.InputEvent("input", {
      bubbles: true,
      composed: true,
      inputType: "insertText",
      data: value,
    }),
  );
  el.dispatchEvent(new realm.Event("change", { bubbles: true, composed: true }));
  el.blur();
}

/** Select an <option> by its value, label, or visible text. */
export function fillSelect(el: HTMLSelectElement, value: string): boolean {
  const realm = realmOf(el);
  const match = Array.from(el.options).find(
    (o) => o.value === value || o.label === value || o.text.trim() === value,
  );
  if (!match) {
    return false;
  }
  el.value = match.value;
  el.dispatchEvent(new realm.Event("input", { bubbles: true, composed: true }));
  el.dispatchEvent(new realm.Event("change", { bubbles: true, composed: true }));
  return el.value === match.value;
}

/** Replace the text of a contenteditable host, dispatching the input events editors listen for. */
export function fillEditable(el: HTMLElement, value: string): boolean {
  const realm = realmOf(el);
  el.focus();
  el.dispatchEvent(
    new realm.InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      composed: true,
      inputType: "insertText",
      data: value,
    }),
  );
  el.textContent = value;
  el.dispatchEvent(
    new realm.InputEvent("input", {
      bubbles: true,
      composed: true,
      inputType: "insertText",
      data: value,
    }),
  );
  return (el.textContent ?? "") === value;
}

const EMPTY_DIFF: Diff = { appeared: [], removed: [], changed: [] };

// `scroll` directions that page the whole viewport rather than centring a specific element.
const SCROLL_DIRECTIONS = new Set(["up", "down", "top", "bottom"]);

// How many viewport pages `scroll: "more"` will try, and the pause after each for lazy content to
// begin loading. Kept small so the whole loop finishes well inside the bridge's request timeout —
// pages like YouTube mutate constantly, so a mutation-settle would never go quiet and would blow the
// budget; a short fixed pause plus a cheap element count is enough to notice new content arriving.
const LOAD_MORE_STEPS = 6;
const LOAD_MORE_PAUSE_MS = 700;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Scroll the page itself — used to reach lazily-loaded content (comments, infinite feeds) that no
 *  current reference points at yet. Returns how far it actually moved, so a caller can tell "nothing
 *  more to load" from "the scroll never moved". */
function scrollViewport(direction: string): { movedPx: number } {
  return scrollActiveSurface(document, direction as ScrollDirection);
}

/**
 * Click by dispatching a realistic pointer+mouse gesture rather than a bare `el.click()`. Modern
 * web-component sites (YouTube's Polymer, Reddit's Lit, many React routers) bind their tap handlers
 * to pointerdown/up and ignore a lone synthetic click, so `.click()` is a silent no-op there. Firing
 * the full sequence — with `composed: true` so it crosses shadow-DOM boundaries — makes those
 * handlers run, while the trailing `click` still triggers native activation (link nav, form submit).
 */
export function dispatchClick(el: Element): void {
  const realm = realmOf(el);
  const PointerCtor = realm.PointerEvent ?? globalThis.PointerEvent;
  const MouseCtor = realm.MouseEvent ?? globalThis.MouseEvent;
  const rect = (el as HTMLElement).getBoundingClientRect?.();
  const clientX = rect ? rect.left + rect.width / 2 : 0;
  const clientY = rect ? rect.top + rect.height / 2 : 0;
  const mouse: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: realm as unknown as Window,
    button: 0,
    clientX,
    clientY,
  };
  const pointer: PointerEventInit = {
    ...mouse,
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
  };
  el.dispatchEvent(new PointerCtor("pointerover", pointer));
  el.dispatchEvent(new PointerCtor("pointerenter", pointer));
  el.dispatchEvent(new PointerCtor("pointerdown", pointer));
  el.dispatchEvent(new MouseCtor("mousedown", mouse));
  if (typeof (el as HTMLElement).focus === "function") {
    (el as HTMLElement).focus();
  }
  el.dispatchEvent(new PointerCtor("pointerup", pointer));
  el.dispatchEvent(new MouseCtor("mouseup", mouse));
  const clickable = el as HTMLElement;
  if (typeof clickable.click === "function") {
    clickable.click();
  } else {
    el.dispatchEvent(new MouseCtor("click", mouse));
  }
}

/** Settle, snapshot the result, remember it for the next act, and report verdict + diff + refs. */
async function settleAndReport(
  action: Action,
  before: { readonly markdown: string; readonly refs: Ref[] },
  valueSet: boolean,
  scope: Node = document.documentElement,
): Promise<ActResult> {
  await settle(scope);
  const after = buildSnapshot(document);
  rememberSnapshot(after.refs, after.elements, after.markdown);
  const diff = computeDiff(before.refs, after.refs);
  return {
    verdict: selectVerdict(action, before.markdown || after.markdown, after.markdown, valueSet),
    diff,
    refs: after.refs,
  };
}

/**
 * Page the document downward until new interactive content appears or the page stops moving. This is
 * the universal "reveal what's below" primitive: one call pages incrementally and settles after each
 * step, so lazy content (comments, infinite feeds, deferred sections) loads as it enters the viewport
 * — instead of the caller guessing how far to jump, and instead of a single jump-to-bottom overshoot
 * skipping past a load-trigger on tall, asymmetric layouts. Stops the moment something loads.
 */
async function loadMore(): Promise<ActResult> {
  const before = rememberedSnapshot() ?? buildSnapshot(document);
  const selected = findScrollTarget(document, "down");
  let contentGrew = false;
  const stopObserving = observeSemanticGrowth(
    document,
    () => {
      contentGrew = true;
    },
    selected.element,
  );
  // Each step: page down one viewport, pause briefly for any lazy content to begin loading, then do a
  // mutation flag. Only when something appears (or we bottom out) do we pay for a full snapshot.
  try {
    for (let step = 0; step < LOAD_MORE_STEPS; step++) {
      // Keep paging the same surface. Re-running composed-tree target selection on every step is
      // needlessly expensive on large application DOMs and can consume the entire action budget.
      const movedPx = scrollSurface(selected.element, "down");
      await wait(LOAD_MORE_PAUSE_MS);
      if (contentGrew) {
        await settle();
        const after = buildSnapshot(document);
        rememberSnapshot(after.refs, after.elements, after.markdown);
        return {
          verdict: "dom_changed",
          diff: computeDiff(before.refs, after.refs),
          refs: after.refs,
        };
      }
      if (movedPx === 0) {
        const after = buildSnapshot(document);
        rememberSnapshot(after.refs, after.elements, after.markdown);
        return {
          verdict: "no_change",
          diff: EMPTY_DIFF,
          refs: after.refs,
          sentinel: { kind: "not_actionable", hint: "reached the bottom — nothing more to load" },
        };
      }
    }
  } finally {
    stopObserving();
  }
  const after = buildSnapshot(document);
  rememberSnapshot(after.refs, after.elements, after.markdown);
  return {
    verdict: "no_change",
    diff: EMPTY_DIFF,
    refs: after.refs,
    sentinel: {
      kind: "not_actionable",
      hint: `paged ${LOAD_MORE_STEPS} screens; no new content appeared (page may defer loading while the tab is in the background)`,
    },
  };
}

async function handleViewportScroll(
  action: Action,
  value?: string,
): Promise<ActResult | undefined> {
  if (action === "scroll" && value === "more") {
    return loadMore();
  }

  if (action === "scroll" && value && SCROLL_DIRECTIONS.has(value)) {
    const before = rememberedSnapshot() ?? buildSnapshot(document);
    const { movedPx } = scrollViewport(value);
    const result = await settleAndReport(action, before, false);
    if (result.verdict === "no_change") {
      return {
        ...result,
        sentinel: {
          kind: "not_actionable",
          hint:
            movedPx === 0
              ? "scroll did not move — the page is at the bottom or doesn't scroll"
              : `scrolled ${movedPx}px but no new content loaded`,
        },
      };
    }
    return result;
  }
  return undefined;
}

function tryPerformFill(
  el: Element,
  value: string | undefined,
  before: {
    readonly refs: Ref[];
    readonly elements: Map<number, Element>;
    readonly markdown: string;
  },
):
  | { kind: "success"; valueSet: boolean }
  | { kind: "not_actionable"; result: ActResult }
  | { kind: "ignored" } {
  if (value === undefined) {
    return { kind: "ignored" };
  }

  let actualValue = value;
  const pressEnter = value.endsWith("\n");
  if (pressEnter) {
    actualValue = value.slice(0, -1);
  }

  if (isTextControl(el)) {
    fillValue(el, actualValue);
    if (pressEnter) {
      const realm = realmOf(el);
      el.dispatchEvent(
        new realm.KeyboardEvent("keydown", {
          bubbles: true,
          composed: true,
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
        }),
      );
      el.dispatchEvent(
        new realm.KeyboardEvent("keypress", {
          bubbles: true,
          composed: true,
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
        }),
      );
      el.dispatchEvent(
        new realm.KeyboardEvent("keyup", {
          bubbles: true,
          composed: true,
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
        }),
      );
    }
    return { kind: "success", valueSet: el.value === actualValue };
  }
  if (isSelectControl(el)) {
    return { kind: "success", valueSet: fillSelect(el, actualValue) };
  }
  if ((el as HTMLElement).isContentEditable) {
    const success = fillEditable(el as HTMLElement, actualValue);
    if (pressEnter) {
      const realm = realmOf(el);
      el.dispatchEvent(
        new realm.KeyboardEvent("keydown", {
          bubbles: true,
          composed: true,
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
        }),
      );
      el.dispatchEvent(
        new realm.KeyboardEvent("keypress", {
          bubbles: true,
          composed: true,
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
        }),
      );
      el.dispatchEvent(
        new realm.KeyboardEvent("keyup", {
          bubbles: true,
          composed: true,
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
        }),
      );
    }
    return { kind: "success", valueSet: success };
  }

  // Not a fillable control — say so explicitly instead of silently reporting no_change.
  rememberSnapshot(before.refs, before.elements, before.markdown);
  return {
    kind: "not_actionable",
    result: {
      verdict: "no_change",
      diff: EMPTY_DIFF,
      refs: before.refs,
      sentinel: {
        kind: "not_actionable",
        hint: "that element can't be filled — re-read and use a text field, dropdown, or editor",
      },
    },
  };
}

/** Resolve `ref`, perform `action`, settle, and report the verdict + diff + fresh references. */
export async function performAct(ref: string, action: Action, value?: string): Promise<ActResult> {
  const scrollResult = await handleViewportScroll(action, value);
  if (scrollResult) {
    return scrollResult;
  }

  const resolution = resolveRef(ref);
  if ("sentinel" in resolution) {
    const snap = buildSnapshot(document);
    rememberSnapshot(snap.refs, snap.elements, snap.markdown);
    return {
      verdict: "no_change",
      diff: EMPTY_DIFF,
      refs: snap.refs,
      sentinel: resolution.sentinel,
    };
  }

  const el = resolution.el;
  const before = rememberedSnapshot() ?? buildSnapshot(document);
  const settleScope = document.documentElement;
  let valueSet = false;

  switch (action) {
    case "click":
      dispatchClick(el);
      break;
    case "fill": {
      const fillResult = tryPerformFill(el, value, before);
      if (fillResult.kind === "not_actionable") {
        return fillResult.result;
      }
      if (fillResult.kind === "success") {
        valueSet = fillResult.valueSet;
        rememberSnapshot(before.refs, before.elements, before.markdown);
        return {
          verdict: valueSet ? "value_set" : "no_change",
          diff: EMPTY_DIFF,
          refs: before.refs,
        };
      }
      break;
    }
    case "scroll":
      el.scrollIntoView({ block: "center" });
      break;
    case "navigate":
      if (value) {
        window.location.href = value;
      }
      break;
  }

  return settleAndReport(action, before, valueSet, settleScope);
}
