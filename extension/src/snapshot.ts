/**
 * The semantic snapshot, built in-page. Walks the DOM in document order and emits clean readable
 * text with interactive elements inlined as `[role "name" #id]` markers, recording a durable recipe
 * per reference. This is the one representation used for both reading and (later) acting.
 */
import type { Ref } from "@browsight/shared";
import {
  elementState,
  fallbackName,
  isHidden,
  isInteractive,
  makeRecipe,
  safeName,
  safeRole,
} from "./dom-utils.ts";

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
  const roleCounts = new Map<string, number>();
  let line = "";
  let nextId = 1;
  let hasPasswordField = false;
  const elements = new Map<number, Element>();

  const title = doc.title.trim();
  if (title) {
    out.push(`# ${title}`);
  }

  function flush(): void {
    const text = line.replace(/\s+/g, " ").trim();
    if (text) {
      out.push(text);
    }
    line = "";
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
    if (el instanceof HTMLInputElement && el.type === "password") {
      hasPasswordField = true;
    }

    if (isInteractive(el)) {
      flush();
      const role = safeRole(el) || tag;
      // Display name falls back to placeholder/title/text when the accessible name is empty, but the
      // recipe keeps the *raw* accessible name so act-time re-resolution (which compares safeName)
      // still matches.
      const rawName = safeName(el);
      const name = rawName || fallbackName(el);
      const ordinal = roleCounts.get(role) ?? 0;
      roleCounts.set(role, ordinal + 1);
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
      return;
    }

    if (/^h[1-6]$/.test(tag)) {
      flush();
      const level = Number(tag.charAt(1));
      const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
      if (text) {
        out.push(`${"#".repeat(level)} ${text}`);
      }
      return;
    }

    for (const child of Array.from(el.childNodes)) {
      walk(child);
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
