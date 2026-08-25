import assert from "node:assert";
import test from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
const gThis = globalThis as unknown as Record<string, unknown>;
gThis.window = dom.window;
gThis.document = dom.window.document;
gThis.Element = dom.window.Element;
gThis.Document = dom.window.Document;

const { documentSignature, signatureChanged, EMPTY_SIGNATURE } = await import(
  "../../../extension/src/perception/signature.ts"
);

test("a signature counts the live document, not the capped snapshot", () => {
  document.body.innerHTML = `<a href="/one">One</a><button>Two</button>`;
  const signature = documentSignature(document);
  assert.ok(signature.elements >= 2);
  assert.equal(signature.interactives, 2);
  assert.ok(signature.textChars > 0);
});

test("content loading far below the snapshot cap is still detected", () => {
  // The regression this exists for: a page whose markdown is already at its cap, so the
  // before/after strings compare equal even though a thousand comments arrived.
  document.body.innerHTML = Array.from(
    { length: 1200 },
    (_, i) => `<a href="/f${i}">Filler ${i} ${"x".repeat(30)}</a>`,
  ).join("");
  const before = documentSignature(document);

  const comments = document.createElement("div");
  comments.innerHTML = Array.from({ length: 50 }, (_, i) => `<p>Comment number ${i}</p>`).join("");
  document.body.appendChild(comments);

  assert.equal(signatureChanged(before, documentSignature(document)), true);
});

test("a ticking clock is not mistaken for new content", () => {
  document.body.innerHTML = `<span id="clock">12:00:00</span>`;
  const before = documentSignature(document);
  (document.getElementById("clock") as HTMLElement).textContent = "12:00:01";
  assert.equal(signatureChanged(before, documentSignature(document)), false);
});

test("an unchanged page reports no change", () => {
  document.body.innerHTML = `<p>Stable</p>`;
  const signature = documentSignature(document);
  assert.equal(signatureChanged(signature, signature), false);
});

test("the empty signature differs from any real page", () => {
  document.body.innerHTML = `<a href="/x">Something</a>`;
  assert.equal(signatureChanged(EMPTY_SIGNATURE, documentSignature(document)), true);
});
