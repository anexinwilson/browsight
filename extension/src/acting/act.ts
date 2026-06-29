/**
 * Acting: perform one bounded action on the page, wait for it to settle, then report a typed verdict
 * and a structural diff. Reference re-resolution lives in `./resolve.ts` and the quiet-window wait in
 * `./settle.ts`; this module orchestrates them.
 */
import type { Action, Diff, Ref, Sentinel, Verdict } from "@browsight/shared";
import { INTERACTIVE_SELECTOR } from "../perception/dom.ts";
import { buildSnapshot } from "../perception/snapshot.ts";
import { computeDiff, selectVerdict } from "./diff.ts";
import { rememberSnapshot, resolveRef } from "./resolve.ts";
import { settle } from "./settle.ts";

export interface ActResult {
  readonly verdict: Verdict;
  readonly diff: Diff;
  readonly refs: Ref[];
  readonly sentinel?: Sentinel;
}

function fillValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  el.focus();
  if (setter) {
    setter.call(el, value);
  } else {
    el.value = value;
  }
  for (const type of ["input", "change", "blur"]) {
    el.dispatchEvent(new Event(type, { bubbles: true }));
  }
}

/** Select an <option> by its value, label, or visible text. */
function fillSelect(el: HTMLSelectElement, value: string): boolean {
  const match = Array.from(el.options).find(
    (o) => o.value === value || o.label === value || o.text.trim() === value,
  );
  if (!match) {
    return false;
  }
  el.value = match.value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return el.value === match.value;
}

/** Replace the text of a contenteditable host, dispatching the input events editors listen for. */
function fillEditable(el: HTMLElement, value: string): boolean {
  el.focus();
  el.dispatchEvent(
    new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "insertText",
      data: value,
    }),
  );
  el.textContent = value;
  el.dispatchEvent(
    new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }),
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
const LOAD_MORE_PAUSE_MS = 450;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A cheap count of interactive elements — used to notice that lazy content has started loading
 *  without paying for a full accessibility snapshot on every page step. */
function interactiveCount(): number {
  return document.querySelectorAll(INTERACTIVE_SELECTOR).length;
}

/** The element that scrolls the page — the document in almost every case. */
function scrollingRoot(): Element {
  return document.scrollingElement ?? document.documentElement;
}

/** Scroll the page itself — used to reach lazily-loaded content (comments, infinite feeds) that no
 *  current reference points at yet. Returns how far it actually moved, so a caller can tell "nothing
 *  more to load" from "the scroll never moved". */
function scrollViewport(direction: string): { movedPx: number } {
  const root = scrollingRoot();
  const startTop = root.scrollTop;
  const page = root.clientHeight || globalThis.innerHeight;
  if (direction === "bottom") {
    root.scrollTo({ top: root.scrollHeight });
  } else if (direction === "top") {
    root.scrollTo({ top: 0 });
  } else {
    root.scrollBy({ top: direction === "up" ? -page : page });
  }
  return { movedPx: Math.round(root.scrollTop - startTop) };
}

/**
 * Click by dispatching a realistic pointer+mouse gesture rather than a bare `el.click()`. Modern
 * web-component sites (YouTube's Polymer, Reddit's Lit, many React routers) bind their tap handlers
 * to pointerdown/up and ignore a lone synthetic click, so `.click()` is a silent no-op there. Firing
 * the full sequence — with `composed: true` so it crosses shadow-DOM boundaries — makes those
 * handlers run, while the trailing `click` still triggers native activation (link nav, form submit).
 */
function dispatchClick(el: Element): void {
  const rect = (el as HTMLElement).getBoundingClientRect?.();
  const clientX = rect ? rect.left + rect.width / 2 : 0;
  const clientY = rect ? rect.top + rect.height / 2 : 0;
  const mouse: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: globalThis as unknown as Window,
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
  el.dispatchEvent(new PointerEvent("pointerover", pointer));
  el.dispatchEvent(new PointerEvent("pointerenter", pointer));
  el.dispatchEvent(new PointerEvent("pointerdown", pointer));
  el.dispatchEvent(new MouseEvent("mousedown", mouse));
  if (el instanceof HTMLElement) {
    el.focus();
  }
  el.dispatchEvent(new PointerEvent("pointerup", pointer));
  el.dispatchEvent(new MouseEvent("mouseup", mouse));
  el.dispatchEvent(new MouseEvent("click", mouse));
}

/** Settle, snapshot the result, remember it for the next act, and report verdict + diff + refs. */
async function settleAndReport(
  action: Action,
  before: { readonly markdown: string; readonly refs: Ref[] },
  valueSet: boolean,
): Promise<ActResult> {
  await settle();
  const after = buildSnapshot(document);
  rememberSnapshot(after.refs, after.elements);
  return {
    verdict: selectVerdict(action, before.markdown, after.markdown, valueSet),
    diff: computeDiff(before.refs, after.refs),
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
  const before = buildSnapshot(document);
  const baseline = interactiveCount();
  // Each step: page down one viewport, pause briefly for any lazy content to begin loading, then do a
  // cheap count check. Only when something new has appeared (or we bottom out) do we pay for a full
  // snapshot. This keeps the whole loop fast enough to finish inside the request timeout.
  for (let step = 0; step < LOAD_MORE_STEPS; step++) {
    const { movedPx } = scrollViewport("down");
    await wait(LOAD_MORE_PAUSE_MS);
    if (interactiveCount() > baseline) {
      await settle();
      const after = buildSnapshot(document);
      rememberSnapshot(after.refs, after.elements);
      return {
        verdict: "dom_changed",
        diff: computeDiff(before.refs, after.refs),
        refs: after.refs,
      };
    }
    if (movedPx === 0) {
      const after = buildSnapshot(document);
      rememberSnapshot(after.refs, after.elements);
      return {
        verdict: "no_change",
        diff: EMPTY_DIFF,
        refs: after.refs,
        sentinel: { kind: "not_actionable", hint: "reached the bottom — nothing more to load" },
      };
    }
  }
  const after = buildSnapshot(document);
  rememberSnapshot(after.refs, after.elements);
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
    const before = buildSnapshot(document);
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

/** Resolve `ref`, perform `action`, settle, and report the verdict + diff + fresh references. */
export async function performAct(ref: string, action: Action, value?: string): Promise<ActResult> {
  const scrollResult = await handleViewportScroll(action, value);
  if (scrollResult) {
    return scrollResult;
  }

  const resolution = resolveRef(ref);
  if ("sentinel" in resolution) {
    const snap = buildSnapshot(document);
    rememberSnapshot(snap.refs, snap.elements);
    return {
      verdict: "no_change",
      diff: EMPTY_DIFF,
      refs: snap.refs,
      sentinel: resolution.sentinel,
    };
  }

  const el = resolution.el;
  const before = buildSnapshot(document);
  let valueSet = false;

  switch (action) {
    case "click":
      dispatchClick(el);
      break;
    case "fill": {
      if (value === undefined) {
        break;
      }
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        fillValue(el, value);
        valueSet = el.value === value;
      } else if (el instanceof HTMLSelectElement) {
        valueSet = fillSelect(el, value);
      } else if (el instanceof HTMLElement && el.isContentEditable) {
        valueSet = fillEditable(el, value);
      } else {
        // Not a fillable control — say so explicitly instead of silently reporting no_change.
        rememberSnapshot(before.refs, before.elements);
        return {
          verdict: "no_change",
          diff: EMPTY_DIFF,
          refs: before.refs,
          sentinel: {
            kind: "not_actionable",
            hint: "that element can't be filled — re-read and use a text field, dropdown, or editor",
          },
        };
      }
      break;
    }
    case "scroll":
      el.scrollIntoView({ block: "center" });
      break;
    case "navigate":
      break;
  }

  return settleAndReport(action, before, valueSet);
}
