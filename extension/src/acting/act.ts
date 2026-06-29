/**
 * Acting: perform one bounded action on the page, wait for it to settle, then report a typed verdict
 * and a structural diff. Reference re-resolution lives in `./resolve.ts` and the quiet-window wait in
 * `./settle.ts`; this module orchestrates them.
 */
import type { Action, Diff, Ref, Sentinel, Verdict } from "@browsight/shared";
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

/** Scroll the viewport itself — used to reach lazily-loaded content (comments, infinite feeds) that
 *  no current reference points at yet. */
function scrollViewport(direction: string): void {
  if (direction === "bottom") {
    window.scrollTo({ top: document.documentElement.scrollHeight });
  } else if (direction === "top") {
    window.scrollTo({ top: 0 });
  } else {
    window.scrollBy({ top: direction === "up" ? -window.innerHeight : window.innerHeight });
  }
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
    view: window,
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

/** Resolve `ref`, perform `action`, settle, and report the verdict + diff + fresh references. */
export async function performAct(ref: string, action: Action, value?: string): Promise<ActResult> {
  // Viewport scroll: `scroll` with a direction value (up/down/top/bottom) instead of a ref pages the
  // window so lazily-loaded content — comments, infinite feeds — enters the DOM for the next read.
  if (action === "scroll" && value && SCROLL_DIRECTIONS.has(value)) {
    const before = buildSnapshot(document);
    scrollViewport(value);
    return settleAndReport(action, before, false);
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
