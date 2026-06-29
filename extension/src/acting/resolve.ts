/**
 * Act-time reference resolution: map a `#id` from the last snapshot back to a live element. The
 * element map from the last snapshot is kept here; if the target has drifted, the durable recipe
 * re-resolves it, narrowing same role+name candidates by every recorded attribute before giving up,
 * and returning a sentinel (rather than guessing) only when the match is missing or truly ambiguous.
 */
import type { Recipe, Ref, Sentinel } from "@browsight/shared";
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

function trimmedText(el: Element): string {
  return (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
}

/** Narrow same role+name candidates using the rest of the recipe: data-* attributes, then text,
 *  then the element's position within the group. */
function narrow(candidates: Element[], recipe: Recipe): Element[] {
  let pool = candidates;
  const dataKeys = Object.keys(recipe.dataAttrs);
  if (dataKeys.length > 0) {
    const byData = pool.filter((el) =>
      dataKeys.every((k) => el.getAttribute(k) === recipe.dataAttrs[k]),
    );
    if (byData.length === 1) {
      return byData;
    }
    if (byData.length > 0) {
      pool = byData;
    }
  }
  if (recipe.text) {
    const byText = pool.filter((el) => trimmedText(el) === recipe.text);
    if (byText.length === 1) {
      return byText;
    }
    if (byText.length > 0) {
      pool = byText;
    }
  }
  const atOrdinal = pool[recipe.ordinal];
  return atOrdinal ? [atOrdinal] : pool;
}

/** Resolve a `#id` to a live element: a re-validated stored fast path, then durable-recipe matching. */
export function resolveRef(ref: string): Resolution {
  const id = Number(ref);
  const recipe = lastRefs.find((r) => r.id === id)?.recipe;
  const stored = lastElements.get(id);
  // Fast path: the stored element, but only if it still looks like the same control — a recycled
  // (virtualized) row keeps the same connected node while changing its accessible name.
  if (
    stored?.isConnected &&
    (!recipe || (safeRole(stored) === recipe.role && safeName(stored) === recipe.name))
  ) {
    return { el: stored };
  }
  if (!recipe) {
    return {
      sentinel: {
        kind: "ref_stale",
        hint: "the page changed — call browser_read to refresh references",
      },
    };
  }
  let matches = Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR)).filter(
    (el) => !isHidden(el) && safeRole(el) === recipe.role && safeName(el) === recipe.name,
  );
  if (matches.length > 1) {
    matches = narrow(matches, recipe);
  }
  if (matches.length > 1) {
    return {
      sentinel: {
        kind: "ambiguous_target",
        hint: `${matches.length} elements still match "${recipe.role} ${recipe.name}" — re-read and use a fresh reference`,
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
