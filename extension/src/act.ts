/**
 * Acting: re-resolve a reference to a live element, perform a bounded action, wait for the page to
 * settle, then report a typed verdict and a diff. The element map from the last snapshot is kept
 * here; if the target has drifted, the durable recipe re-resolves it (returning a sentinel when the
 * match is missing or ambiguous, rather than guessing).
 */
import type { Action, Diff, Ref, Sentinel, Verdict } from "@browsight/shared";
import { computeDiff, selectVerdict } from "./diff.ts";
import { INTERACTIVE_SELECTOR, isHidden, safeName, safeRole } from "./dom-utils.ts";
import { buildSnapshot } from "./snapshot.ts";

let lastRefs: Ref[] = [];
let lastElements = new Map<number, Element>();

/** Remember the element map from the most recent snapshot so refs resolve at act time. */
export function rememberSnapshot(refs: Ref[], elements: Map<number, Element>): void {
  lastRefs = refs;
  lastElements = elements;
}

export interface ActResult {
  readonly verdict: Verdict;
  readonly diff: Diff;
  readonly refs: Ref[];
  readonly sentinel?: Sentinel;
}

type Resolution = { readonly el: Element } | { readonly sentinel: Sentinel };

function resolveRef(ref: string): Resolution {
  const id = Number(ref);
  const stored = lastElements.get(id);
  if (stored?.isConnected) {
    return { el: stored };
  }
  const recipe = lastRefs.find((r) => r.id === id)?.recipe;
  if (!recipe) {
    return {
      sentinel: {
        kind: "ref_stale",
        hint: "the page changed — call browser_read to refresh references",
      },
    };
  }
  const matches = Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR)).filter(
    (el) => !isHidden(el) && safeRole(el) === recipe.role && safeName(el) === recipe.name,
  );
  if (matches.length > 1) {
    return {
      sentinel: {
        kind: "ambiguous_target",
        hint: `${matches.length} elements match "${recipe.role} ${recipe.name}" — re-read and use a fresh reference`,
      },
    };
  }
  const [match] = matches;
  if (match) {
    return { el: match };
  }
  return {
    sentinel: {
      kind: "ref_stale",
      hint: "could not find that element — call browser_read to refresh references",
    },
  };
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

function settle(timeoutMs = 1200, quietMs = 250): Promise<void> {
  return new Promise((resolve) => {
    let quietTimer = 0;
    const observer = new MutationObserver(() => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(finish, quietMs);
    });
    const hardTimer = setTimeout(finish, timeoutMs);
    function finish(): void {
      observer.disconnect();
      clearTimeout(quietTimer);
      clearTimeout(hardTimer);
      resolve();
    }
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
    });
    quietTimer = setTimeout(finish, quietMs);
  });
}

const EMPTY_DIFF: Diff = { appeared: [], removed: [], changed: [] };

/** Resolve `ref`, perform `action`, settle, and report the verdict + diff + fresh references. */
export async function performAct(ref: string, action: Action, value?: string): Promise<ActResult> {
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

  await settle();
  const after = buildSnapshot(document);
  rememberSnapshot(after.refs, after.elements);

  return {
    verdict: selectVerdict(action, before.markdown, after.markdown, valueSet),
    diff: computeDiff(before.refs, after.refs),
    refs: after.refs,
  };
}
