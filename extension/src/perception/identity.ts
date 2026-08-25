/**
 * Reference numbering: which `#id` an element answers to, for as long as the page stays loaded.
 *
 * Ids used to be the element's position in whichever walk produced the snapshot, so the same control
 * was `#15` in a `mode: "main"` read and `#16` in a full one, and a narrowed read (a query, or a
 * later window of a long page) renumbered everything it did emit. An agent holding a reference from
 * one read could act on a different control after another, with nothing to warn it.
 *
 * Numbering is therefore owned here instead: an element takes an id the first time it is seen and
 * keeps it, whatever a later read asks for. Every element ever numbered stays resolvable, so a
 * reference from an earlier read still works after a narrower one.
 *
 * The registry lives on the page's `globalThis` because the content script is re-injected on every
 * read and act, which would reset a module-level binding. It is rebuilt when `performance.timeOrigin`
 * changes, which is exactly when the document is replaced, so ids never survive a navigation into a
 * page where they would mean something else.
 */

interface PageIdentity {
  readonly pageLoad: number;
  readonly ids: WeakMap<Element, number>;
  readonly elements: Map<number, Element>;
  next: number;
}

function identity(): PageIdentity {
  const scope = globalThis as typeof globalThis & { __browsightIds?: PageIdentity };
  const pageLoad = Math.round(performance.timeOrigin);
  if (scope.__browsightIds?.pageLoad !== pageLoad) {
    scope.__browsightIds = {
      pageLoad,
      ids: new WeakMap<Element, number>(),
      elements: new Map<number, Element>(),
      next: 1,
    };
  }
  return scope.__browsightIds;
}

/** The id this element answers to, assigning one the first time it is seen. */
export function idFor(el: Element): number {
  const state = identity();
  const existing = state.ids.get(el);
  if (existing !== undefined) {
    return existing;
  }
  const id = state.next++;
  state.ids.set(el, id);
  state.elements.set(id, el);
  return id;
}

/** Look up any element numbered during this page load, including from an earlier read. */
export function elementForId(id: number): Element | undefined {
  return identity().elements.get(id);
}

/** Discard the numbering. Only for tests, which reuse one document across cases. */
export function resetIdentity(): void {
  const scope = globalThis as typeof globalThis & { __browsightIds?: PageIdentity };
  delete scope.__browsightIds;
}
