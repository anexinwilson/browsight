/**
 * Acting: perform one bounded action on the page, wait for it to settle, then report a typed verdict
 * and a structural diff. Reference re-resolution lives in `./resolve.ts` and the quiet-window wait in
 * `./settle.ts`; this module orchestrates them.
 */

import type { Action, ActResponse, Diff, FieldFill } from "@browsight/shared";
import { signatureChanged } from "../perception/signature.ts";
import { buildSnapshot, type SnapshotMode, type SnapshotResult } from "../perception/snapshot.ts";
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
  isScrollDirection,
  observeSemanticGrowth,
  type ScrollDirection,
  scrollActiveSurface,
  scrollSurface,
} from "./scroll.ts";
import { settle } from "./settle.ts";

/** The half of a snapshot an action compares against afterwards. */
type Compared = Pick<SnapshotResult, "markdown" | "refs" | "signature"> & {
  readonly mode: SnapshotMode;
};

/**
 * What one action did, in the shape the bridge sends back. Derived from the wire type so acting and
 * the protocol cannot drift.
 */
export type ActResult = Omit<ActResponse, "type" | "id">;

// How many viewport pages `scroll: "more"` will try, and the pause after each for lazy content to
// begin loading. Kept small so the whole loop finishes well inside the bridge's request timeout,
// pages like YouTube mutate constantly, so a mutation-settle would never go quiet and would blow the
// budget; a short fixed pause plus a cheap element count is enough to notice new content arriving.
const LOAD_MORE_STEPS = 6;
const LOAD_MORE_PAUSE_MS = 700;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The snapshot an action is measured against: the last complete read, or a fresh one. */
function basisSnapshot(): Compared {
  const remembered = rememberedSnapshot();
  if (remembered) {
    return remembered;
  }
  const fresh = buildSnapshot(document);
  return { ...fresh, mode: "full" };
}

/** Scroll the page itself, used to reach lazily-loaded content (comments, infinite feeds) that no
 *  current reference points at yet. Returns how far it actually moved, so a caller can tell "nothing
 *  more to load" from "the scroll never moved". */
const EMPTY_DIFF: Diff = { appeared: [], removed: [], changed: [] };

function scrollViewport(direction: ScrollDirection): { movedPx: number } {
  return scrollActiveSurface(document, direction);
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
  before: Compared,
  valueSet: boolean,
  scope: Node = document.documentElement,
  beforeHref = "",
): Promise<ActResult> {
  await settle(scope);
  // Build the comparison in the same mode the basis was built in. Comparing a `main` read against a
  // `full` snapshot describes the difference between two views of the page rather than anything the
  // action did, and reports the whole document as newly appeared.
  const after = buildSnapshot(document, { mode: before.mode });
  rememberSnapshot(after.refs, after.markdown, after.signature, before.mode);
  const diff = computeDiff(before.refs, after.refs);
  const navigated = beforeHref !== "" && currentHref() !== beforeHref;
  const contentChanged = signatureChanged(before.signature, after.signature);
  const verdict = selectVerdict(
    action,
    before.markdown || after.markdown,
    after.markdown,
    valueSet,
    navigated,
    contentChanged,
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
  const before = basisSnapshot();
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
        const after = buildSnapshot(document, { mode: before.mode });
        rememberSnapshot(after.refs, after.markdown, after.signature, before.mode);
        return {
          verdict: "dom_changed",
          diff: computeDiff(before.refs, after.refs),
          refs: after.refs,
        };
      }
      if (movedPx === 0) {
        const after = buildSnapshot(document, { mode: before.mode });
        rememberSnapshot(after.refs, after.markdown, after.signature, before.mode);
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
  const after = buildSnapshot(document, { mode: before.mode });
  rememberSnapshot(after.refs, after.markdown, after.signature, before.mode);
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

  if (action === "scroll" && value && isScrollDirection(value)) {
    const before = basisSnapshot();
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
  before: Compared,
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
      dispatchEnter(el);
    }
    return { kind: "success", valueSet: el.value === actualValue };
  }
  if (isSelectControl(el)) {
    return { kind: "success", valueSet: fillSelect(el, actualValue) };
  }
  if ((el as HTMLElement).isContentEditable) {
    const success = fillEditable(el as HTMLElement, actualValue);
    if (pressEnter) {
      dispatchEnter(el);
    }
    return { kind: "success", valueSet: success };
  }

  // Not a fillable control, say so explicitly instead of silently reporting no_change.
  rememberSnapshot(before.refs, before.markdown, before.signature, before.mode);
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
/**
 * Fill the control, then let the caller settle and report like any other action. Filling is not
 * inherently inert: an Enter submits a form, and a select's change handler can navigate, so
 * deciding up front which fills "cannot" change the page is guesswork that silently loses whatever
 * did happen. Settling always costs one quiet-window wait and reports what actually changed.
 */
function applyFill(
  el: Element,
  value: string | undefined,
  before: Compared,
): { kind: "done"; result: ActResult } | { kind: "settle"; valueSet: boolean } {
  const fillResult = tryPerformFill(el, value, before);
  if (fillResult.kind === "not_actionable") {
    return { kind: "done", result: fillResult.result };
  }
  return { kind: "settle", valueSet: fillResult.kind === "success" && fillResult.valueSet };
}

/**
 * Fill several controls in one pass. Each reference is resolved immediately before its own fill, so
 * a re-render triggered by an earlier field cannot invalidate the ones after it, and the page is
 * settled once at the end instead of after every field. A field that cannot be resolved or filled
 * is reported rather than aborting the rest, because a half-filled form the caller knows about is
 * more useful than one it does not.
 */
export async function performBatchFill(fields: readonly FieldFill[]): Promise<ActResult> {
  const before = basisSnapshot();
  const beforeHref = currentHref();
  const failed: string[] = [];
  let filled = 0;

  for (const field of fields) {
    const resolution = resolveRef(field.ref);
    if ("sentinel" in resolution) {
      failed.push(`#${field.ref} could not be found`);
      continue;
    }
    const outcome = applyFill(resolution.el, field.value, before);
    if (outcome.kind === "done" || !outcome.valueSet) {
      failed.push(`#${field.ref} is not a fillable control`);
      continue;
    }
    filled++;
  }

  const result = await settleAndReport(
    "fill",
    before,
    filled > 0,
    document.documentElement,
    beforeHref,
  );
  if (failed.length === 0) {
    return result;
  }
  return {
    ...result,
    sentinel: {
      kind: "not_actionable",
      hint: `filled ${filled} of ${fields.length} fields; ${failed.join(", ")}`,
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
    rememberSnapshot(snap.refs, snap.markdown, snap.signature);
    return {
      verdict: "no_change",
      diff: EMPTY_DIFF,
      refs: snap.refs,
      sentinel: resolution.sentinel,
    };
  }

  const el = resolution.el;
  const before = basisSnapshot();
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
