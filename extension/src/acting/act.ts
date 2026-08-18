/**
 * Acting: perform one bounded action on the page, wait for it to settle, then report a typed verdict
 * and a structural diff. Reference re-resolution lives in `./resolve.ts` and the quiet-window wait in
 * `./settle.ts`; this module orchestrates them.
 */

import type { Action, Diff, Ref, Sentinel, Verdict } from "@browsight/shared";
import { buildSnapshot } from "../perception/snapshot.ts";
import { computeDiff, selectVerdict } from "./diff.ts";
import {
  dispatchClick,
  dispatchEnter,
  fillEditable,
  fillSelect,
  fillValue,
  isSelectControl,
  isTextControl,
} from "./input.ts";
import { rememberedSnapshot, rememberSnapshot, resolveRef } from "./resolve.ts";
import {
  findScrollTarget,
  observeSemanticGrowth,
  type ScrollDirection,
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

const SCROLL_DIRECTIONS = new Set(["up", "down", "top", "bottom"]);

// How many viewport pages `scroll: "more"` will try, and the pause after each for lazy content to
// begin loading. Kept small so the whole loop finishes well inside the bridge's request timeout,
// pages like YouTube mutate constantly, so a mutation-settle would never go quiet and would blow the
// budget; a short fixed pause plus a cheap element count is enough to notice new content arriving.
const LOAD_MORE_STEPS = 6;
const LOAD_MORE_PAUSE_MS = 700;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Scroll the page itself, used to reach lazily-loaded content (comments, infinite feeds) that no
 *  current reference points at yet. Returns how far it actually moved, so a caller can tell "nothing
 *  more to load" from "the scroll never moved". */
const EMPTY_DIFF: Diff = { appeared: [], removed: [], changed: [] };

function scrollViewport(direction: string): { movedPx: number } {
  return scrollActiveSurface(document, direction as ScrollDirection);
}

/**
 * Click by dispatching a realistic pointer+mouse gesture rather than a bare `el.click()`. Modern
 * web-component sites (YouTube's Polymer, Reddit's Lit, many React routers) bind their tap handlers
 * to pointerdown/up and ignore a lone synthetic click, so `.click()` is a silent no-op there. Firing
 * the full sequence, with `composed: true` so it crosses shadow-DOM boundaries, makes those
 * handlers run, while the trailing `click` still triggers native activation (link nav, form submit).
 */
function currentHref(): string {
  return typeof location === "undefined" ? "" : location.href;
}

/** Settle, snapshot the result, remember it for the next act, and report verdict + diff + refs. */
async function settleAndReport(
  action: Action,
  before: { readonly markdown: string; readonly refs: Ref[] },
  valueSet: boolean,
  scope: Node = document.documentElement,
  beforeHref = "",
): Promise<ActResult> {
  await settle(scope);
  const after = buildSnapshot(document);
  rememberSnapshot(after.refs, after.elements, after.markdown);
  const diff = computeDiff(before.refs, after.refs);
  const navigated = beforeHref !== "" && currentHref() !== beforeHref;
  const verdict = selectVerdict(
    action,
    before.markdown || after.markdown,
    after.markdown,
    valueSet,
    navigated,
  );
  // A bare "no_change" leaves the caller unable to tell a dud reference from a
  // control that genuinely does nothing, and those need different next steps.
  // Callers with a more specific explanation override this sentinel.
  if (verdict === "no_change") {
    return {
      verdict,
      diff,
      refs: after.refs,
      sentinel: {
        kind: "not_actionable",
        hint: `the ${action} reached the element but the page did not change, it may be inert, may need a different interaction, or may have opened a new tab (check browser_tabs)`,
      },
    };
  }
  return { verdict, diff, refs: after.refs };
}

/**
 * Page the document downward until new interactive content appears or the page stops moving. This is
 * the universal "reveal what's below" primitive: one call pages incrementally and settles after each
 * step, so lazy content (comments, infinite feeds, deferred sections) loads as it enters the viewport
 *, instead of the caller guessing how far to jump, and instead of a single jump-to-bottom overshoot
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
          sentinel: { kind: "not_actionable", hint: "reached the bottom, nothing more to load" },
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
    const beforeHref = currentHref();
    const { movedPx } = scrollViewport(value);
    const result = await settleAndReport(
      action,
      before,
      false,
      document.documentElement,
      beforeHref,
    );
    if (result.verdict === "no_change") {
      return {
        ...result,
        sentinel: {
          kind: "not_actionable",
          hint:
            movedPx === 0
              ? "scroll did not move, the page is at the bottom or doesn't scroll"
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
  | { kind: "success"; valueSet: boolean; submitted: boolean }
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
      dispatchEnter(el);
    }
    return { kind: "success", valueSet: el.value === actualValue, submitted: pressEnter };
  }
  if (isSelectControl(el)) {
    return { kind: "success", valueSet: fillSelect(el, actualValue), submitted: false };
  }
  if ((el as HTMLElement).isContentEditable) {
    const success = fillEditable(el as HTMLElement, actualValue);
    if (pressEnter) {
      dispatchEnter(el);
    }
    return { kind: "success", valueSet: success, submitted: pressEnter };
  }

  // Not a fillable control, say so explicitly instead of silently reporting no_change.
  rememberSnapshot(before.refs, before.elements, before.markdown);
  return {
    kind: "not_actionable",
    result: {
      verdict: "no_change",
      diff: EMPTY_DIFF,
      refs: before.refs,
      sentinel: {
        kind: "not_actionable",
        hint: "that element can't be filled, re-read and use a text field, dropdown, or editor",
      },
    },
  };
}

/** Resolve `ref`, perform `action`, settle, and report the verdict + diff + fresh references. */
type Snapshotted = {
  readonly refs: Ref[];
  readonly elements: Map<number, Element>;
  readonly markdown: string;
};

/**
 * Fill the control and decide whether the caller can stop here. Typing into a box leaves the page
 * where it was, so the expensive settle and snapshot are skipped. Submitting it does not: an Enter
 * can navigate or swap the whole view, so that case falls through to the normal settle and report.
 */
function applyFill(
  el: Element,
  value: string | undefined,
  before: Snapshotted,
): { kind: "done"; result: ActResult } | { kind: "settle"; valueSet: boolean } {
  const fillResult = tryPerformFill(el, value, before);
  if (fillResult.kind === "not_actionable") {
    return { kind: "done", result: fillResult.result };
  }
  if (fillResult.kind !== "success") {
    return { kind: "settle", valueSet: false };
  }
  if (fillResult.submitted) {
    return { kind: "settle", valueSet: fillResult.valueSet };
  }
  rememberSnapshot(before.refs, before.elements, before.markdown);
  return {
    kind: "done",
    result: {
      verdict: fillResult.valueSet ? "value_set" : "no_change",
      diff: EMPTY_DIFF,
      refs: before.refs,
    },
  };
}

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
  const beforeHref = currentHref();
  const settleScope = document.documentElement;
  let valueSet = false;

  switch (action) {
    case "click":
      dispatchClick(el);
      break;
    case "fill": {
      const outcome = applyFill(el, value, before);
      if (outcome.kind === "done") {
        return outcome.result;
      }
      valueSet = outcome.valueSet;
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

  return settleAndReport(action, before, valueSet, settleScope, beforeHref);
}
