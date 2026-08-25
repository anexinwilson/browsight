/**
 * A whole-document fingerprint, deliberately independent of the emitted snapshot markdown.
 *
 * The markdown a snapshot produces is capped, so on a dense page (a video watch page, a long feed)
 * everything past that cap is simply absent from the string. Answering "did this action change the
 * page?" by comparing two capped strings therefore reports "no change" for any change below the
 * cut, which is exactly where lazily-loaded content lands. Counting the live DOM cannot be hidden
 * that way, so acting uses this as its coarse signal and the markdown as its fine one.
 */
import { INTERACTIVE_SELECTOR } from "./dom.ts";

export interface DocumentSignature {
  readonly elements: number;
  readonly interactives: number;
  readonly textChars: number;
}

export const EMPTY_SIGNATURE: DocumentSignature = {
  elements: 0,
  interactives: 0,
  textChars: 0,
};

/** Count the live document cheaply, using native queries rather than another tree walk. */
export function documentSignature(doc: Document = document): DocumentSignature {
  return {
    elements: doc.querySelectorAll("*").length,
    interactives: doc.querySelectorAll(INTERACTIVE_SELECTOR).length,
    textChars: (doc.body?.textContent ?? "").length,
  };
}

// Clocks, view counters and video timers rewrite a few characters continuously. Requiring more than
// a token's worth of drift keeps those from reading as real content, while still catching anything
// an action actually loaded.
const TEXT_NOISE_CHARS = 40;

/** Whether two signatures differ by more than incidental page noise. */
export function signatureChanged(before: DocumentSignature, after: DocumentSignature): boolean {
  return (
    before.elements !== after.elements ||
    before.interactives !== after.interactives ||
    Math.abs(after.textChars - before.textChars) > TEXT_NOISE_CHARS
  );
}
