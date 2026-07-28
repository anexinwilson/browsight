import { INTERACTIVE_SELECTOR } from "../perception/dom.ts";

export type ScrollDirection = "up" | "down" | "top" | "bottom";

export interface ScrollResult {
  readonly movedPx: number;
  readonly target: Element;
  readonly targetKind: "document" | "container";
}

export interface SemanticStats {
  readonly elements: number;
  readonly interactives: number;
  readonly textChars: number;
  readonly scrollRange: number;
}

function scrollPosition(el: Element): number {
  return Math.round(el.scrollTop);
}

function remainingScroll(el: Element, direction: ScrollDirection): number {
  if (direction === "up" || direction === "top") {
    return el.scrollTop;
  }
  return el.scrollHeight - el.clientHeight - el.scrollTop;
}

function visibleArea(el: Element): number {
  const view = el.ownerDocument.defaultView;
  const rect = el.getBoundingClientRect();
  const width = Math.max(
    0,
    Math.min(rect.right, view?.innerWidth ?? rect.right) - Math.max(0, rect.left),
  );
  const height = Math.max(
    0,
    Math.min(rect.bottom, view?.innerHeight ?? rect.bottom) - Math.max(0, rect.top),
  );
  return width * height;
}

function composedElements(doc: Document): Element[] {
  const elements: Element[] = [];
  const visitRoot = (root: Document | ShadowRoot): void => {
    for (const el of Array.from(root.querySelectorAll("*"))) {
      elements.push(el);
      if (el.shadowRoot) {
        visitRoot(el.shadowRoot);
      }
      if (el.tagName.toLowerCase() === "iframe") {
        try {
          const frameDoc = (el as HTMLIFrameElement).contentDocument;
          if (frameDoc) {
            visitRoot(frameDoc);
          }
        } catch {
          // Cross-origin frames are intentionally unavailable to the content script.
        }
      }
    }
  };
  visitRoot(doc);
  return elements;
}

function walkComposedRoot(
  root: Document | ShadowRoot,
  limit: number,
): { readonly elements: Element[]; readonly nestedRoots: (Document | ShadowRoot)[] } {
  const elements: Element[] = [];
  const nestedRoots: (Document | ShadowRoot)[] = [];
  const rootDocument = root instanceof Document ? root : root.ownerDocument;
  const showElement = rootDocument.defaultView?.NodeFilter.SHOW_ELEMENT ?? 1;
  const walker = rootDocument.createTreeWalker(root, showElement);
  let current = walker.nextNode();
  while (current && elements.length < limit) {
    const el = current as Element;
    elements.push(el);
    if (el.shadowRoot) {
      nestedRoots.push(el.shadowRoot);
    }
    const frameDoc = sameOriginFrameDocument(el);
    if (frameDoc) {
      nestedRoots.push(frameDoc);
    }
    current = walker.nextNode();
  }
  return { elements, nestedRoots };
}

function sameOriginFrameDocument(el: Element): Document | null {
  if (el.tagName.toLowerCase() !== "iframe") {
    return null;
  }
  try {
    return (el as HTMLIFrameElement).contentDocument;
  } catch {
    // Cross-origin frames are intentionally unavailable to the content script.
    return null;
  }
}

/**
 * Inspect a bounded prefix of the composed tree for a last-resort scroll surface. The focused,
 * centred, semantic, and document-root paths above handle normal pages; this fallback exists for
 * unusual application shells but must not become proportional to an unbounded feed.
 */
function boundedComposedElements(doc: Document, limit = 750): Element[] {
  const elements: Element[] = [];
  const roots: (Document | ShadowRoot)[] = [doc];
  const seen = new Set<Document | ShadowRoot>();
  while (roots.length > 0 && elements.length < limit) {
    const root = roots.shift();
    if (!root || seen.has(root)) {
      continue;
    }
    seen.add(root);
    const batch = walkComposedRoot(root, limit - elements.length);
    elements.push(...batch.elements);
    roots.push(...batch.nestedRoots);
  }
  return elements;
}

function favoredAncestors(doc: Document): Set<Element> {
  const favored = new Set<Element>();
  const addAncestors = (start: Element | null): void => {
    let current = start;
    while (current) {
      favored.add(current);
      const root = current.getRootNode();
      current = current.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
    }
  };
  addAncestors(doc.activeElement);
  const view = doc.defaultView;
  if (view && typeof doc.elementFromPoint === "function") {
    addAncestors(doc.elementFromPoint(view.innerWidth / 2, view.innerHeight / 2));
  }
  return favored;
}

function isScrollableContainer(el: Element, direction: ScrollDirection): boolean {
  if (el.scrollHeight <= el.clientHeight + 2 || remainingScroll(el, direction) <= 1) {
    return false;
  }
  const view = el.ownerDocument.defaultView;
  const overflowY = view?.getComputedStyle(el).overflowY ?? "";
  return /^(auto|scroll|overlay)$/.test(overflowY);
}

/** Choose the visible scroll surface most likely to contain the user's current task. */
export function findScrollTarget(
  doc: Document,
  direction: ScrollDirection,
): { readonly element: Element; readonly kind: "document" | "container" } {
  const root = doc.scrollingElement ?? doc.documentElement;
  const favored = favoredAncestors(doc);
  const best: { element: Element | null; score: number } = {
    element: null,
    score: Number.NEGATIVE_INFINITY,
  };

  const consider = (el: Element): void => {
    if (!isScrollableContainer(el, direction)) {
      return;
    }
    const area = visibleArea(el);
    if (area <= 0) {
      return;
    }
    const role = el.getAttribute("role");
    const semanticBonus = role === "main" || el.tagName.toLowerCase() === "main" ? area * 0.3 : 0;
    const focusBonus = favored.has(el) ? area * 0.5 : 0;
    const rangeBonus = Math.min(remainingScroll(el, direction), 10_000);
    const score = area + semanticBonus + focusBonus + rangeBonus;
    if (score > best.score) {
      best.element = el;
      best.score = score;
    }
  };

  // Most application scrollers are either around the focused/centered task or carry a semantic
  // landmark. Checking those first keeps target selection proportional to the task surface rather
  // than to a feed's entire (potentially enormous) DOM.
  for (const el of favored) {
    consider(el);
  }
  for (const el of Array.from(
    doc.querySelectorAll("main,[role='main'],[role='feed'],[role='grid'],[role='list']"),
  )) {
    consider(el);
  }

  if (best.element) {
    return { element: best.element, kind: "container" };
  }

  // Traditional documents—including large feeds such as YouTube—scroll at the document root.
  // Avoid a full composed-tree scan when that root can already satisfy the requested direction.
  if (remainingScroll(root, direction) > 1) {
    return { element: root, kind: "document" };
  }

  // Fallback for non-semantic application shells whose scroll pane is neither focused nor centred.
  for (const el of boundedComposedElements(doc)) {
    consider(el);
  }
  if (best.element) {
    return { element: best.element, kind: "container" };
  }
  return { element: root, kind: "document" };
}

/** Scroll an already-selected surface without rescanning the composed tree. */
export function scrollSurface(target: Element, direction: ScrollDirection): number {
  const startTop = scrollPosition(target);
  const view = target.ownerDocument.defaultView;
  const page = Math.round((target.clientHeight || view?.innerHeight || 0) * 0.8);
  if (direction === "bottom") {
    target.scrollTo({ top: target.scrollHeight });
  } else if (direction === "top") {
    target.scrollTo({ top: 0 });
  } else {
    target.scrollBy({ top: direction === "up" ? -page : page });
  }
  return Math.round(scrollPosition(target) - startTop);
}

/** Scroll the active document or application container by an overlapping 80% page. */
export function scrollActiveSurface(doc: Document, direction: ScrollDirection): ScrollResult {
  const selected = findScrollTarget(doc, direction);
  const target = selected.element;
  return {
    movedPx: scrollSurface(target, direction),
    target,
    targetKind: selected.kind,
  };
}

/** Cheap composed-tree signal used to notice text, controls, or scroll range added lazily. */
export function semanticStats(doc: Document): SemanticStats {
  let elements = 0;
  let interactives = 0;
  let textChars = 0;
  let scrollRange = 0;

  for (const el of composedElements(doc)) {
    elements++;
    if (el.matches(INTERACTIVE_SELECTOR)) {
      interactives++;
    }
    scrollRange += Math.max(0, el.scrollHeight - el.clientHeight);
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        textChars += (child.textContent ?? "").trim().length;
      }
    }
  }
  return { elements, interactives, textChars, scrollRange };
}

export function hasSemanticGrowth(before: SemanticStats, after: SemanticStats): boolean {
  return (
    after.elements > before.elements ||
    after.interactives > before.interactives ||
    after.textChars > before.textChars + 20 ||
    after.scrollRange > before.scrollRange + 20
  );
}

/**
 * Observe lazy content on the document and the selected scroll surface's own composed root.
 * Watching the active root covers document, shadow-DOM, and same-origin-frame surfaces without an
 * eager walk through every element on a large application page.
 */
export function observeSemanticGrowth(
  doc: Document,
  onGrowth: () => void,
  activeSurface?: Element,
): () => void {
  const observers: MutationObserver[] = [];
  const observed = new Set<Node>();
  const observeRoot = (root: Document | ShadowRoot): void => {
    const target = root instanceof Document ? root.documentElement : root;
    if (!target || observed.has(target)) {
      return;
    }
    observed.add(target);
    const observer = new MutationObserver((records) => {
      if (
        records.some(
          (record) =>
            (record.type === "childList" && record.addedNodes.length > 0) ||
            (record.type === "characterData" &&
              (record.target.textContent ?? "").trim().length > 0),
        )
      ) {
        onGrowth();
      }
    });
    observer.observe(target, { childList: true, subtree: true, characterData: true });
    observers.push(observer);
  };

  observeRoot(doc);
  if (activeSurface) {
    const surfaceDoc = activeSurface.ownerDocument;
    if (surfaceDoc !== doc) {
      observeRoot(surfaceDoc);
    }
    if (activeSurface.shadowRoot) {
      observeRoot(activeSurface.shadowRoot);
    }
    const root = activeSurface.getRootNode();
    if (root instanceof ShadowRoot) {
      observeRoot(root);
    }
  }

  return () => {
    for (const observer of observers) {
      observer.disconnect();
    }
  };
}
