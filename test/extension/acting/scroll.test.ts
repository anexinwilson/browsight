import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import {
  findScrollTarget,
  hasSemanticGrowth,
  observeSemanticGrowth,
  scrollActiveSurface,
  semanticStats,
} from "../../../extension/src/acting/scroll.ts";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://example.com/",
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  Node: dom.window.Node,
  Element: dom.window.Element,
  Document: dom.window.Document,
  ShadowRoot: dom.window.ShadowRoot,
  HTMLElement: dom.window.HTMLElement,
  MutationObserver: dom.window.MutationObserver,
});

function numericProperty(
  element: Element,
  name: "clientHeight" | "scrollHeight" | "scrollTop",
  initial: number,
): { readonly value: number } {
  let value = initial;
  Object.defineProperty(element, name, {
    configurable: true,
    get: () => value,
    set: (next: number) => {
      value = next;
    },
  });
  return {
    get value() {
      return value;
    },
  };
}

test("scrollActiveSurface pages a visible inner application container", () => {
  document.body.innerHTML = '<main id="app" style="overflow-y:auto"><button>Inbox</button></main>';
  const app = document.querySelector("#app") as HTMLElement;
  const top = numericProperty(app, "scrollTop", 100);
  numericProperty(app, "clientHeight", 500);
  numericProperty(app, "scrollHeight", 2_000);
  app.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 900, bottom: 500, width: 900, height: 500 }) as DOMRect;
  app.scrollBy = ((opts: ScrollToOptions = {}) => {
    const delta = opts.top ?? 0;
    app.scrollTop += Number(delta);
  }) as typeof app.scrollBy;
  app.scrollTo = ((opts: ScrollToOptions = {}) => {
    const next = opts.top ?? 0;
    app.scrollTop = Number(next);
  }) as typeof app.scrollTo;

  const selected = findScrollTarget(document, "down");
  const result = scrollActiveSurface(document, "down");

  assert.equal(selected.element, app);
  assert.equal(selected.kind, "container");
  assert.equal(result.targetKind, "container");
  assert.equal(result.movedPx, 400);
  assert.equal(top.value, 500);
});

test("scrollActiveSurface supports top and bottom on an inner container", () => {
  document.body.innerHTML = '<div id="feed" style="overflow-y:scroll"></div>';
  const feed = document.querySelector("#feed") as HTMLElement;
  const top = numericProperty(feed, "scrollTop", 300);
  numericProperty(feed, "clientHeight", 300);
  numericProperty(feed, "scrollHeight", 1_500);
  feed.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 600, bottom: 300, width: 600, height: 300 }) as DOMRect;
  feed.scrollBy = ((opts: ScrollToOptions = {}) => {
    feed.scrollTop += Number(opts.top ?? 0);
  }) as typeof feed.scrollBy;
  feed.scrollTo = ((opts: ScrollToOptions = {}) => {
    feed.scrollTop = Number(opts.top ?? 0);
  }) as typeof feed.scrollTo;

  scrollActiveSurface(document, "bottom");
  assert.equal(top.value, 1_500);
  scrollActiveSurface(document, "top");
  assert.equal(top.value, 0);
});

test("semantic growth notices content added inside open shadow DOM", () => {
  document.body.innerHTML = '<section id="host"></section>';
  const host = document.querySelector("#host") as HTMLElement;
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = "<p>Initial content</p>";
  const before = semanticStats(document);

  const button = document.createElement("button");
  button.textContent = "Load another result with meaningful text";
  shadow.appendChild(button);
  const after = semanticStats(document);

  assert.equal(hasSemanticGrowth(before, after), true);
  assert.ok(after.interactives > before.interactives);
});

test("composed mutation observer notices lazy content inside shadow DOM", async () => {
  document.body.innerHTML = '<section id="observer-host"></section>';
  const host = document.querySelector("#observer-host") as HTMLElement;
  const shadow = host.attachShadow({ mode: "open" });
  let growthEvents = 0;
  const stop = observeSemanticGrowth(
    document,
    () => {
      growthEvents++;
    },
    host,
  );

  shadow.append(document.createElement("button"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  stop();

  assert.ok(growthEvents > 0);
});

test("a container with a sliver of slack does not outrank a page with room to scroll", () => {
  // Regression: qualifying on "more than one pixel remaining" let a nearly-exhausted inner
  // container win over the document root, so a page with thousands of pixels below reported
  // "scroll did not move, the page is at the bottom".
  document.body.innerHTML = `<div id="sliver" style="overflow-y: auto"></div>`;
  const sliver = document.getElementById("sliver") as HTMLElement;
  Object.defineProperty(sliver, "clientHeight", { value: 600, configurable: true });
  Object.defineProperty(sliver, "scrollHeight", { value: 602, configurable: true });
  sliver.scrollTop = 0;

  const root = document.scrollingElement ?? document.documentElement;
  Object.defineProperty(root, "clientHeight", { value: 800, configurable: true });
  Object.defineProperty(root, "scrollHeight", { value: 6000, configurable: true });
  root.scrollTop = 0;

  const target = findScrollTarget(document, "down");
  assert.equal(target.kind, "document");
  assert.notEqual(target.element, sliver);
});
