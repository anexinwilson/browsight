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
class SnapshotBuilder {
  refs: Ref[] = [];
  out: string[] = [];
  ordinals = new Map<string, number>();
  line = "";
  nextId = 1;
  hasPasswordField = false;
  lastRefName = "";
  elements = new Map<number, Element>();

  private doc: Document;

  constructor(doc: Document) {
    this.doc = doc;
  }

  build(): SnapshotResult {
    const title = this.doc.title.trim();
    if (title) {
      this.out.push(`# ${title}`);
    }

    if (this.doc.body) {
      this.walk(this.doc.body);
    }
    this.flush();

    const markdown = this.out
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return {
      markdown,
      refs: this.refs,
      hasPasswordField: this.hasPasswordField,
      elements: this.elements,
    };
  }

  private flush(): void {
    const text = this.line
      .replace(/[ \t\n\r]+/g, " ")
      .replace(/(?: \b\d\b){8,}/g, "")
      .replace(/[ \t\n\r]+/g, " ")
      .trim();
    if (text) {
      this.out.push(text);
      this.lastRefName = "";
    }
    this.line = "";
  }

  private handleInteractive(el: Element, tag: string): void {
    this.flush();
    const role = safeRole(el) || tag;
    const rawName = safeName(el);
    const name = rawName || fallbackName(el);
    const ordinalKey = `${role}\n${rawName}`;
    const ordinal = this.ordinals.get(ordinalKey) ?? 0;
    this.ordinals.set(ordinalKey, ordinal + 1);
    const id = this.nextId++;
    const state = elementState(el);
    this.refs.push({
      id,
      role,
      name,
      recipe: makeRecipe(el, role, rawName, ordinal),
      ...(state ? { state } : {}),
    });
    this.elements.set(id, el);
    this.out.push(`[${role} ${JSON.stringify(name)} #${id}]`);
    this.lastRefName = name;
    if (isComposite(el)) {
      for (const child of Array.from(el.childNodes)) {
        this.walk(child);
      }
      this.flush();
    }
  }

  private handleHeading(el: Element, tag: string): void {
    this.flush();
    const level = Number(tag.charAt(1));
    const fullText = (el.textContent ?? "").replace(/[ \t\n\r]+/g, " ").trim();
    if (fullText && fullText === this.lastRefName) {
      this.lastRefName = "";
      return;
    }
    let directText = "";
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        directText += ` ${child.textContent ?? ""}`;
      }
    }
    directText = directText.replace(/[ \t\n\r]+/g, " ").trim();
    if (directText) {
      this.out.push(`${"#".repeat(level)} ${directText}`);
    }
    this.lastRefName = "";
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        this.walk(child);
      }
    }
  }

  private handleIframe(el: HTMLIFrameElement): void {
    this.flush();
    let frameDoc: Document | null = null;
    try {
      frameDoc = el.contentDocument;
    } catch {
      frameDoc = null;
    }
    if (frameDoc?.body) {
      this.walk(frameDoc.body);
    } else {
      this.out.push("[unreadable frame (cross-origin)]");
    }
  }

  private shouldSkipElement(el: Element, tag: string): boolean {
    if (SKIP_TAGS.has(tag) || isHidden(el)) {
      return true;
    }
    if (tag === "footer" || el.getAttribute("role") === "contentinfo") {
      return true;
    }
    return false;
  }

  private isPasswordField(el: Element): boolean {
    return el instanceof HTMLInputElement && el.type === "password";
  }

  private handleInteractiveOrSpecial(el: Element, tag: string): boolean {
    if (isInteractive(el)) {
      this.handleInteractive(el, tag);
      return true;
    }
    if (/^h[1-6]$/.test(tag)) {
      this.handleHeading(el, tag);
      return true;
    }
    if (el instanceof HTMLIFrameElement) {
      this.handleIframe(el);
      return true;
    }
    return false;
  }

  private walkChildren(el: Element): void {
    for (const child of Array.from(el.childNodes)) {
      this.walk(child);
    }
    if (el.shadowRoot) {
      for (const child of Array.from(el.shadowRoot.childNodes)) {
        this.walk(child);
      }
    }
  }

  private walk(node: Node): void {
    if (node.nodeType === Node.TEXT_NODE) {
      this.line += ` ${node.textContent ?? ""}`;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return;
    }
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (this.shouldSkipElement(el, tag)) {
      return;
    }
    if (this.isPasswordField(el)) {
      this.hasPasswordField = true;
    }

    if (this.handleInteractiveOrSpecial(el, tag)) {
      return;
    }

    this.walkChildren(el);

    if (BLOCK_TAGS.has(tag)) {
      this.flush();
    }
  }
}

/** Build the semantic snapshot of `doc` (the live document by default). */
export function buildSnapshot(doc: Document = document): SnapshotResult {
  return new SnapshotBuilder(doc).build();
}
