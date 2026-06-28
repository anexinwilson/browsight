/**
 * Act-time reference resolution: map a `#id` from the last snapshot back to a live element. The
 * element map from the last snapshot is kept here; if the target has drifted, the durable recipe
 * re-resolves it, returning a sentinel (rather than guessing) when the match is missing or ambiguous.
 */
import type { Ref, Sentinel } from "@browsight/shared";
import { safeName, safeRole } from "../perception/accessibility.ts";
import { INTERACTIVE_SELECTOR, isHidden } from "../perception/dom.ts";

let lastRefs: Ref[] = [];
let lastElements = new Map<number, Element>();

/** Remember the element map from the most recent snapshot so refs resolve at act time. */
export function rememberSnapshot(refs: Ref[], elements: Map<number, Element>): void {
  lastRefs = refs;
  lastElements = elements;
}

export type Resolution = { readonly el: Element } | { readonly sentinel: Sentinel };

/** Resolve a `#id` to a live element: stored-map fast path, then durable-recipe re-resolution. */
export function resolveRef(ref: string): Resolution {
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
