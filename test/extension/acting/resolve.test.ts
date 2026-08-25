import assert from "node:assert/strict";
import test from "node:test";
import type { Recipe, Ref } from "@browsight/shared";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
const gThis = globalThis as unknown as Record<string, unknown>;
gThis.window = dom.window;
gThis.document = dom.window.document;
gThis.Node = dom.window.Node;
gThis.Element = dom.window.Element;
gThis.Document = dom.window.Document;
gThis.ShadowRoot = dom.window.ShadowRoot;
gThis.HTMLElement = dom.window.HTMLElement;
gThis.HTMLIFrameElement = dom.window.HTMLIFrameElement;
gThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
// JSDOM lays nothing out, so every element reports a 0x0 box and `isHidden` would reject them all.
dom.window.HTMLElement.prototype.getBoundingClientRect = () =>
  ({
    width: 100,
    height: 100,
    top: 0,
    left: 0,
    bottom: 100,
    right: 100,
    x: 0,
    y: 0,
    toJSON: () => {},
  }) as DOMRect;
Object.defineProperty(dom.window.HTMLElement.prototype, "offsetWidth", {
  get: () => 100,
  configurable: true,
});
Object.defineProperty(dom.window.HTMLElement.prototype, "offsetHeight", {
  get: () => 100,
  configurable: true,
});

const { rememberSnapshot, resolveRef } = await import("../../../extension/src/acting/resolve.ts");
const { idFor, resetIdentity } = await import("../../../extension/src/perception/identity.ts");

function recipe(over: Partial<Recipe> = {}): Recipe {
  return { role: "button", name: "Save", dataAttrs: {}, text: "", ordinal: 0, ...over };
}

function ref(id: number, over: Partial<Recipe> = {}): Ref {
  const r = recipe(over);
  return { id, role: r.role, name: r.name, recipe: r };
}

function reset(): void {
  document.body.innerHTML = "";
  resetIdentity();
}

test("a remembered element is returned directly when it still looks like the same control", () => {
  reset();
  const button = document.createElement("button");
  button.setAttribute("aria-label", "Save");
  document.body.append(button);
  const id = idFor(button);
  rememberSnapshot([ref(id)]);

  const resolution = resolveRef(String(id));
  assert.ok("el" in resolution);
  assert.equal(resolution.el, button);
});

test("a reference with no recipe and no live element is reported as stale", () => {
  reset();
  rememberSnapshot([]);
  const resolution = resolveRef("404");
  assert.ok("sentinel" in resolution);
  assert.equal(resolution.sentinel.kind, "ref_stale");
  assert.match(resolution.sentinel.hint, /call browser_read/);
});

test("a recycled row is rejected and re-resolved rather than acted on by mistake", () => {
  reset();
  // Virtualised lists reuse the same node for a different row: still connected, different control.
  const recycled = document.createElement("button");
  recycled.setAttribute("aria-label", "Delete");
  document.body.append(recycled);
  const real = document.createElement("button");
  real.setAttribute("aria-label", "Save");
  document.body.append(real);

  const id = idFor(recycled);
  rememberSnapshot([ref(id)]);

  const resolution = resolveRef(String(id));
  assert.ok("el" in resolution);
  assert.equal(
    resolution.el,
    real,
    "must find the control the recipe describes, not the reused node",
  );
});

test("an element removed from the page is re-resolved through its recipe", () => {
  reset();
  const gone = document.createElement("button");
  gone.setAttribute("aria-label", "Save");
  const id = idFor(gone); // never appended, so it is not connected

  const replacement = document.createElement("button");
  replacement.setAttribute("aria-label", "Save");
  document.body.append(replacement);
  rememberSnapshot([ref(id)]);

  const resolution = resolveRef(String(id));
  assert.ok("el" in resolution);
  assert.equal(resolution.el, replacement);
});

test("duplicates are narrowed by a recorded data attribute", () => {
  reset();
  for (const value of ["one", "two", "three"]) {
    const button = document.createElement("button");
    button.setAttribute("aria-label", "Save");
    button.setAttribute("data-id", value);
    document.body.append(button);
  }
  rememberSnapshot([ref(7, { dataAttrs: { "data-id": "two" } })]);

  const resolution = resolveRef("7");
  assert.ok("el" in resolution);
  assert.equal((resolution.el as Element).getAttribute("data-id"), "two");
});

test("duplicates are narrowed by the text the reference was recorded with", () => {
  reset();
  for (const label of ["Alpha", "Beta"]) {
    const button = document.createElement("button");
    button.setAttribute("aria-label", "Save");
    button.textContent = label;
    document.body.append(button);
  }
  rememberSnapshot([ref(3, { text: "Beta" })]);

  const resolution = resolveRef("3");
  assert.ok("el" in resolution);
  assert.equal((resolution.el as Element).textContent, "Beta");
});

test("identical duplicates fall back to the position the reference was taken from", () => {
  reset();
  for (let i = 0; i < 3; i++) {
    const button = document.createElement("button");
    button.setAttribute("aria-label", "Save");
    document.body.append(button);
  }
  rememberSnapshot([ref(5, { ordinal: 2 })]);

  const resolution = resolveRef("5");
  assert.ok("el" in resolution);
  assert.equal(resolution.el, document.querySelectorAll("button")[2]);
});

test("a target that cannot be told apart is refused instead of guessed", () => {
  reset();
  for (let i = 0; i < 3; i++) {
    const button = document.createElement("button");
    button.setAttribute("aria-label", "Save");
    document.body.append(button);
  }
  // An ordinal past the end leaves the pool ambiguous rather than picking one at random.
  rememberSnapshot([ref(9, { ordinal: 99 })]);

  const resolution = resolveRef("9");
  assert.ok("sentinel" in resolution);
  assert.equal(resolution.sentinel.kind, "ambiguous_target");
  assert.match(resolution.sentinel.hint, /3 elements still match/);
});

test("a reference to something no longer on the page is reported as stale", () => {
  reset();
  rememberSnapshot([ref(11)]);
  const resolution = resolveRef("11");
  assert.ok("sentinel" in resolution);
  assert.equal(resolution.sentinel.kind, "ref_stale");
  assert.match(resolution.sentinel.hint, /could not find that element/);
});

test("hidden controls are not offered as matches", () => {
  reset();
  const hidden = document.createElement("button");
  hidden.setAttribute("aria-label", "Save");
  hidden.setAttribute("aria-hidden", "true");
  document.body.append(hidden);
  rememberSnapshot([ref(13)]);

  const resolution = resolveRef("13");
  assert.ok("sentinel" in resolution);
  assert.equal(resolution.sentinel.kind, "ref_stale");
});

test("a leading # on a reference is accepted", () => {
  reset();
  const button = document.createElement("button");
  button.setAttribute("aria-label", "Save");
  document.body.append(button);
  const id = idFor(button);
  rememberSnapshot([ref(id)]);

  const resolution = resolveRef(`#${id}`);
  assert.ok("el" in resolution);
  assert.equal(resolution.el, button);
});

test("controls inside a shadow root are reachable", () => {
  reset();
  const host = document.createElement("div");
  document.body.append(host);
  const shadow = host.attachShadow({ mode: "open" });
  const inner = document.createElement("button");
  inner.setAttribute("aria-label", "Save");
  shadow.append(inner);
  rememberSnapshot([ref(21)]);

  const resolution = resolveRef("21");
  assert.ok("el" in resolution);
  assert.equal(resolution.el, inner);
});
