/**
 * The semantic snapshot, built in-page. Walks the DOM in document order and emits clean readable
 * text with interactive elements inlined as `[role "name" #id]` markers, recording a durable recipe
 * per reference. This is the one representation used for both reading and (later) acting.
 */
import type { Ref } from "@browsight/shared";
import { elementState, fallbackName, safeName, safeRole } from "./accessibility.ts";
import { isComposite, isHidden, isInteractive } from "./dom.ts";
import { idFor } from "./identity.ts";
import { makeRecipe } from "./recipe.ts";
import { activeDialogRoot, CHROME_SELECTOR, primaryContentRoot } from "./regions.ts";
import { type DocumentSignature, documentSignature } from "./signature.ts";

export interface SnapshotResult {
  readonly markdown: string;
  readonly refs: Ref[];
  readonly hasPasswordField: boolean;
  readonly elements: Map<number, Element>;
  /** Whether output was cut short, and where a follow-up read should resume from. */
  readonly truncated: boolean;
  readonly nextOffset: number;
  readonly signature: DocumentSignature;
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
const MAX_SNAPSHOT_CHARS = 16_000;
export type SnapshotMode = "full" | "main";

/**
 * What became of one emitted line: kept in the output window, skipped because it falls outside the
 * requested window or does not match the query (its children are still visited, so offsets stay
 * stable), or stopped because the window is now full.
 */
type EmitStatus = "kept" | "skipped" | "stopped";

/** Build the semantic snapshot of `doc` (the live document by default). */
class SnapshotBuilder {
  refs: Ref[] = [];
  out: string[] = [];
  header: string[] = [];
  ordinals = new Map<string, number>();
  line = "";
  hasPasswordField = false;
  lastRefName = "";
  private lastLink: { role: string; name: string; href: string } | null = null;
  private skipChrome = false;
  elements = new Map<number, Element>();
  truncated = false;
  outputChars = 0;
  /** Characters the walk has produced document-wide, including those skipped before `offset`. */
  producedChars = 0;
  nextOffset = 0;

  private readonly doc: Document;

  private readonly mode: SnapshotMode;

  private readonly offset: number;

  /** Lowercased search text; when set, only matching lines are kept. */
  private readonly query: string;

  constructor(doc: Document, mode: SnapshotMode, offset: number, query: string) {
    this.doc = doc;
    this.mode = mode;
    this.query = query.trim().toLowerCase();
    // A search covers the whole document, so a window into one part of it would be meaningless.
    this.offset = this.query ? 0 : Math.max(0, offset);
  }

  build(): SnapshotResult {
    // A modal is the primary content while it is open, but "full" must still mean the whole page:
    // scoping it to the dialog silently hid everything behind it, with no way for the caller to see
    // what it was missing.
    const openDialog = activeDialogRoot(this.doc);
    const dialog = this.mode === "main" ? openDialog : null;
    const primary = !dialog && this.mode === "main" ? primaryContentRoot(this.doc) : null;

    this.writeHeader(dialog, openDialog, primary);

    // "main" with no landmark used to mean "the whole page", which on a site like a storefront is
    // mostly navigation, footer filters and banners. Skip those framing regions instead so the mode
    // keeps its meaning everywhere.
    this.skipChrome = this.mode === "main" && !dialog && !primary;
    const root = dialog ?? primary ?? this.doc.body;
    if (root) {
      this.walk(root);
    }
    this.flush();

    if (this.truncated) {
      this.out.push(
        this.query
          ? "[too many matches to show; use a more specific query]"
          : `[snapshot truncated here; call browser_read again with offset=${this.nextOffset} for the next part, or pass query= to search the whole page]`,
      );
    }

    const markdown = [...this.header, ...this.out]
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return {
      markdown,
      refs: this.refs,
      hasPasswordField: this.hasPasswordField,
      elements: this.elements,
      truncated: this.truncated,
      nextOffset: this.truncated ? this.nextOffset : 0,
      signature: documentSignature(this.doc),
    };
  }

  /**
   * Announce what this snapshot is: which page, which region of it, and how it was narrowed.
   *
   * These lines sit outside the output window, so they frame every page of a paginated read rather
   * than scrolling off it after the first.
   */
  private writeHeader(
    dialog: Element | null,
    openDialog: Element | null,
    primary: Element | null,
  ): void {
    const title = this.doc.title.trim();
    if (title) {
      this.header.push(`# ${title}`);
    }
    if (dialog) {
      this.header.push(
        "[focused on active dialog; call browser_read with mode=full to see the page behind it]",
      );
    } else if (openDialog) {
      this.header.push(
        "[a dialog is open over this page; it may block interaction until dismissed]",
      );
    } else if (this.mode === "main") {
      this.header.push(
        primary ? "[focused on primary content]" : "[no primary landmark; showing full page]",
      );
    }
    if (this.offset > 0) {
      this.header.push(`[continued from offset ${this.offset}]`);
    }
    if (this.query) {
      this.header.push(`[showing only lines matching "${this.query}"; whole page searched]`);
    }
  }

  /**
   * Append one line, honouring the requested window. Text before `offset` is counted but not kept,
   * so a follow-up read resumes exactly where the last one stopped while ids and ordinals stay
   * identical to an unpaginated walk: a `#id` means the same element on every page.
   */
  private emit(text: string): EmitStatus {
    // A search walks the entire page and pays only for what matches, so the cap limits results
    // rather than reading depth. Non-matching lines cost nothing and their children are still
    // visited, which is what lets a query find text far below where a plain read would stop.
    if (this.query && !text.toLowerCase().includes(this.query)) {
      return "skipped";
    }
    const cost = text.length + (this.producedChars > 0 ? 1 : 0);
    const startedAt = this.producedChars;
    this.producedChars += cost;
    if (this.producedChars <= this.offset) {
      return "skipped";
    }
    if (this.outputChars + cost > MAX_SNAPSHOT_CHARS) {
      this.truncated = true;
      this.nextOffset = startedAt;
      return "stopped";
    }
    this.out.push(text);
    this.outputChars += cost;
    return "kept";
  }

  private flush(): void {
    const text = this.line
      .replace(/[ \t\n\r]+/g, " ")
      .replace(/(?: \b\d\b){8,}/g, "")
      .replace(/[ \t\n\r]+/g, " ")
      .trim();
    if (text) {
      this.emit(text);
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
    // The ordinal is consumed even when the marker is skipped below: recipes resolve by
    // counting matching elements in the DOM, so a gap here would make every later
    // element of the same role and name resolve to the wrong node.
    this.ordinals.set(ordinalKey, ordinal + 1);

    // Listing pages wrap each result in an image link and a title link carrying the
    // same accessible name and target, which doubles the cost of every search page.
    // One marker is enough, both go to the same place.
    const href = role === "link" ? el.getAttribute("href") : null;
    if (
      href &&
      this.lastLink?.href === href &&
      this.lastLink.name === name &&
      this.lastLink.role === role
    ) {
      return;
    }
    this.lastLink = href ? { role, name, href } : null;

    const id = idFor(el);
    const state = elementState(el);
    const status = this.emit(`[${role} ${JSON.stringify(name)} #${id}]`);
    if (status === "stopped") {
      return;
    }
    // A reference is only offered when the caller can actually see it. Content before the window is
    // still descended into, because skipping it would change the character counts that later
    // offsets are measured against.
    if (status === "kept") {
      this.refs.push({
        id,
        role,
        name,
        recipe: makeRecipe(el, role, rawName, ordinal),
        ...(state ? { state } : {}),
      });
      this.elements.set(id, el);
      this.lastRefName = name;
    }
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
      this.emit(`${"#".repeat(level)} ${directText}`);
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
      this.emit("[unreadable frame (cross-origin)]");
    }
  }

  private shouldSkipElement(el: Element, tag: string): boolean {
    if (SKIP_TAGS.has(tag) || isHidden(el)) {
      return true;
    }
    if (tag === "footer" || el.getAttribute("role") === "contentinfo") {
      return true;
    }
    if (this.skipChrome && el.matches(CHROME_SELECTOR)) {
      return true;
    }
    return false;
  }

  private isPasswordField(el: Element): boolean {
    return el.tagName.toLowerCase() === "input" && (el as HTMLInputElement).type === "password";
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
    if (tag === "iframe") {
      this.handleIframe(el as HTMLIFrameElement);
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
    if (this.truncated) {
      return;
    }
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
export function buildSnapshot(
  doc: Document = document,
  options: {
    readonly mode?: SnapshotMode;
    readonly offset?: number;
    readonly query?: string;
  } = {},
): SnapshotResult {
  return new SnapshotBuilder(
    doc,
    options.mode ?? "full",
    options.offset ?? 0,
    options.query ?? "",
  ).build();
}
