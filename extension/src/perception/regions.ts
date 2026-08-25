/**
 * Choosing what part of a page to read.
 *
 * `main` mode narrows a snapshot to the region carrying the page's actual content: an open dialog
 * while one is up, otherwise the strongest content landmark. Everything here matches on standard
 * ARIA roles and HTML elements only, never on site-specific ids or classes, so the behaviour is the
 * same on every site rather than tuned for a few.
 */
import { isHidden } from "./dom.ts";

export function activeDialogRoot(doc: Document): Element | null {
  const active = doc.activeElement;
  const dialogs = Array.from(
    doc.querySelectorAll("dialog[open], [role='dialog'], [aria-modal='true']"),
  ).filter((element) => !isHidden(element));
  if (active !== null && active !== doc.body) {
    const focusedDialog = dialogs.findLast((element) => element.contains(active));
    if (focusedDialog) {
      return focusedDialog;
    }
  }
  return (
    dialogs.findLast((element) => element.matches("dialog[open], [aria-modal='true']")) ?? null
  );
}

/**
 * Landmarks that can stand in for `main` when a page declares none, tried in order. All are standard
 * ARIA roles or HTML elements, never site-specific ids or classes, so this behaves the same
 * everywhere: a results page that marks its results as a feed, list or grid gets the focus a `main`
 * would have given it instead of falling back to the entire document.
 */
/**
 * The only landmark trusted to mean "the page's content".
 *
 * Guessing a stand-in when a page declares no `main` was tried and removed. Containers like
 * `[role='list']` or `article` say nothing about being primary, and on a storefront the
 * highest-scoring one is often a sponsored carousel: link-dense enough to win, holding a fraction of
 * the page. Focusing it dropped every organic result while still reporting "focused on primary
 * content", so a wrong answer was indistinguishable from a right one. A page without `main` now
 * reports exactly that and returns the whole document, and `query`/`offset` handle the size.
 */
export const PRIMARY_LANDMARK = "main, [role='main']";

export function primaryContentRoot(doc: Document): Element | null {
  return bestScoringCandidate(doc.querySelectorAll(PRIMARY_LANDMARK));
}

/** Pick the candidate carrying the most content, scoring controls well above prose. */
function bestScoringCandidate(candidates: ArrayLike<Element>): Element | null {
  let best: { readonly element: Element; readonly score: number } | null = null;
  for (const element of Array.from(candidates)) {
    if (isHidden(element)) {
      continue;
    }
    const text = (element.textContent ?? "").trim().length;
    const controls = element.querySelectorAll(
      "a[href], button, input, select, textarea, [contenteditable='true']",
    ).length;
    const score = text + controls * 80;
    if (!best || score > best.score) {
      best = { element, score };
    }
  }
  return best?.element ?? null;
}

/**
 * Regions that frame a page rather than carry its content. Matched by landmark role
 * and tag only, never by site-specific ids or classes, so this stays honest on any
 * site. A page with no semantic markup at all gets no benefit, which is the correct
 * outcome: guessing would risk dropping real content.
 */
export const CHROME_SELECTOR =
  "nav, header, footer, aside, [role='navigation'], [role='banner'], [role='contentinfo'], [role='complementary']";
