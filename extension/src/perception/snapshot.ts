/**
 * The semantic snapshot, built in-page. Walks the DOM in document order and emits clean readable
 * text with interactive elements inlined as `[role "name" #id]` markers, recording a durable recipe
 * per reference. This is the one representation used for both reading and (later) acting.
 */
import type { Ref } from "@browsight/shared";
import { elementState, fallbackName, safeName, safeRole } from "./accessibility.ts";
import { isComposite, isHidden, isInteractive } from "./dom.ts";
import { makeRecipe } from "./recipe.ts";

export interface SnapshotResult {
  readonly markdown: string;
  readonly refs: Ref[];
  readonly hasPasswordField: boolean;
  readonly elements: Map<number, Element>;
}

const SKIP_TAGS = new Set(["script", "style", "noscript", "template", "svg"]);
const BLOCK_TAGS = new Set([
  "p",
  "div",
  "section",
  "article",
  "li",
  "tr",
  "header",
  "footer",
  "main",
  "nav",
  "ul",
  "ol",
  "table",
  "br",
]);

/** Build the semantic snapshot of `doc` (the live document by default). */
export function buildSnapshot(doc: Document = document): SnapshotResult {
  const refs: Ref[] = [];
  const out: string[] = [];
  const ordinals = new Map<string, number>();
  let line = "";
  let nextId = 1;
  let hasPasswordField = false;
  let lastRefName = "";
  const elements = new Map<number, Element>();

  const title = doc.title.trim();
  if (title) {
    out.push(`# ${title}`);
  }

  function flush(): void {
    // Collapse animated odometer counters (e.g. YouTube view counts) that dump every digit of every
    // column as "1 2 3 4 5 6 7 8 9 0 ..." — a long run of single spaced digits is never real content.
    const text = line
      .replace(/[ \t\n\r]+/g, " ")
      .replace(/(?: \b\d\b ){7,}\b\d\b/g, "")
      .replace(/[ \t\n\r]+/g, " ")
      .trim();
    if (text) {
      out.push(text);
      lastRefName = "";
    }
    line = "";
  }

  function handleInteractive(el: Element, tag: string): void {
    flush();
    const role = safeRole(el) || tag;
    // Display name falls back to placeholder/title/text when the accessible name is empty, but the
    // recipe keeps the *raw* accessible name so act-time re-resolution (which compares safeName)
    // still matches.
    const rawName = safeName(el);
    const name = rawName || fallbackName(el);
    // Count position within the role+name group so the act-time resolver can pick the right one
    // among identically-named controls.
    const ordinalKey = `${role}\n${rawName}`;
    const ordinal = ordinals.get(ordinalKey) ?? 0;
    ordinals.set(ordinalKey, ordinal + 1);
    const id = nextId++;
    const state = elementState(el);
    refs.push({
      id,
      role,
      name,
      recipe: makeRecipe(el, role, rawName, ordinal),
      ...(state ? { state } : {}),
    });
    elements.set(id, el);
    out.push(`[${role} ${JSON.stringify(name)} #${id}]`);
    lastRefName = name;
    // Composite controls (contenteditable editors, listbox/combobox, select) wrap their content —
    // keep walking so the editor text and option labels stay in the snapshot.
    if (isComposite(el)) {
      for (const child of Array.from(el.childNodes)) {
        walk(child);
      }
      flush();
    }
  }

  function handleHeading(el: Element, tag: string): void {
    flush();
    const level = Number(tag.charAt(1));
    const fullText = (el.textContent ?? "").replace(/[ \t\n\r]+/g, " ").trim();
    // Card titles are frequently both a clickable ref and a heading with identical text (job
    // boards, search results, news indexes). If this heading just repeats the interactive ref
    // emitted immediately before it, drop it — the ref already carries the title and is clickable.
    if (fullText && fullText === lastRefName) {
      lastRefName = "";
      return;
    }
    // Emit only the heading's own direct text, then walk its element children, so a link wrapped
    // inside the heading (very common in feeds) still becomes a clickable reference instead of an
    // un-actionable title.
    let directText = "";
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        directText += ` ${child.textContent ?? ""}`;
      }
    }
    directText = directText.replace(/[ \t\n\r]+/g, " ").trim();
    if (directText) {
      out.push(`${"#".repeat(level)} ${directText}`);
    }
    lastRefName = "";
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        walk(child);
      }
    }
  }

  function handleIframe(el: HTMLIFrameElement): void {
    flush();
    let frameDoc: Document | null = null;
    try {
      frameDoc = el.contentDocument;
    } catch {
      frameDoc = null;
    }
    if (frameDoc?.body) {
      walk(frameDoc.body);
    } else {
      out.push("[unreadable frame (cross-origin)]");
    }
  }

  function walk(node: Node): void {
    if (node.nodeType === Node.TEXT_NODE) {
      line += ` ${node.textContent ?? ""}`;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return;
    }
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag) || isHidden(el)) {
      return;
    }
    // Footer / contentinfo landmarks are copyright and site-map boilerplate that rarely matter for a
    // task and dominate the token cost on dense pages — skip the subtree.
    if (tag === "footer" || el.getAttribute("role") === "contentinfo") {
      return;
    }
    if (el instanceof HTMLInputElement && el.type === "password") {
      hasPasswordField = true;
    }

    if (isInteractive(el)) {
      handleInteractive(el, tag);
      return;
    }

    if (/^h[1-6]$/.test(tag)) {
      handleHeading(el, tag);
      return;
    }

    // Same-origin iframe: descend into its document. Cross-origin or otherwise blocked: emit an
    // explicit marker so the gap is visible instead of a silent empty.
    if (el instanceof HTMLIFrameElement) {
      handleIframe(el);
      return;
    }

    for (const child of Array.from(el.childNodes)) {
      walk(child);
    }
    // Open shadow roots render content that is not in childNodes — descend into them too.
    if (el.shadowRoot) {
      for (const child of Array.from(el.shadowRoot.childNodes)) {
        walk(child);
      }
    }
    if (BLOCK_TAGS.has(tag)) {
      flush();
    }
  }

  if (doc.body) {
    walk(doc.body);
  }
  flush();

  const markdown = out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { markdown, refs, hasPasswordField, elements };
}
