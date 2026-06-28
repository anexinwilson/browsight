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
      if (el instanceof HTMLElement) {
        el.click();
      } else {
        // SVG-rooted and other non-HTML controls have no .click() — dispatch a real click event so
        // the action lands instead of silently no-op'ing into a misleading "no_change".
        el.dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true, view: window }),
        );
      }
      break;
    case "fill":
      if (
        (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) &&
        value !== undefined
      ) {
        fillValue(el, value);
        valueSet = el.value === value;
      }
      break;
    case "scroll":
      el.scrollIntoView({ block: "center" });
      break;
    case "navigate":
      break;
  }

  return settleAndReport(action, before, valueSet);
}
