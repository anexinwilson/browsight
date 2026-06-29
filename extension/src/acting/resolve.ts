/**
 * Act-time reference resolution: map a `#id` from the last snapshot back to a live element. The
 * element map from the last snapshot is kept here; if the target has drifted, the durable recipe
 * re-resolves it, narrowing same role+name candidates by every recorded attribute before giving up,
 * and returning a sentinel (rather than guessing) only when the match is missing or truly ambiguous.
 */
import type { Recipe, Ref, Sentinel } from "@browsight/shared";
import { safeName, safeRole } from "../perception/accessibility.ts";
import { INTERACTIVE_SELECTOR, isHidden } from "../perception/dom.ts";

interface RefState {
  refs: Ref[];
  elements: Map<number, Element>;
}

/**
 * Keep the ref/element map on a stable per-tab global rather than a module-level binding. The content
 * script is re-injected on every read and every act, which re-runs this module with a fresh binding —
 * so a module-level cache can be empty at act time even immediately after a read, making every ref
 * resolve to `ref_stale`. The isolated world's `globalThis` persists across those re-injections, so
 * the act sees the references the read recorded.
 */
function refState(): RefState {
  const g = globalThis as typeof globalThis & { __browsightRefs?: RefState };
  if (!g.__browsightRefs) {
    g.__browsightRefs = { refs: [], elements: new Map() };
  }
  return g.__browsightRefs;
}

/** Remember the element map from the most recent snapshot so refs resolve at act time. */
export function rememberSnapshot(refs: Ref[], elements: Map<number, Element>): void {
  const s = refState();
  s.refs = refs;
  s.elements = elements;
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

/**
 * Every interactive element under `root`, descending into open shadow roots — the same reach the
 * snapshot has when it reads the page. Without this, references recorded inside a web component's
 * shadow DOM (e.g. Reddit's entire `shreddit-*` UI) can be read but never re-resolved at act time,
 * because a plain `document.querySelectorAll` does not cross shadow boundaries.
 */
function allInteractive(root: Document | ShadowRoot): Element[] {
  const out = Array.from(root.querySelectorAll(INTERACTIVE_SELECTOR));
  for (const host of root.querySelectorAll("*")) {
    if (host.shadowRoot) {
      out.push(...allInteractive(host.shadowRoot));
    }
  }
  return out;
}

/** Resolve a `#id` to a live element: the stored element handle first, then durable-recipe matching
 *  (which descends shadow roots). Accepts the id with or without the leading "#". */
export function resolveRef(ref: string): Resolution {
  const { refs, elements } = refState();
  const id = Number(ref.replace(/^#/, ""));
  const recipe = refs.find((r) => r.id === id)?.recipe;
  // The stored element is a direct handle, so it works through shadow DOM / iframes for free and
  // survives a re-render that only moves the node; the role+name re-check below rejects it if the
  // node was recycled into a different control. The recipe re-resolution is the fallback.
  const stored = elements.get(id);
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
  let matches = allInteractive(document).filter(
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
