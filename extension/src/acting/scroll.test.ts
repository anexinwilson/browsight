import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import {
  findScrollTarget,
  hasSemanticGrowth,
  observeSemanticGrowth,
  scrollActiveSurface,
  semanticStats,
} from "./scroll.ts";

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
  app.scrollBy = ({ top: delta = 0 }) => {
    app.scrollTop += Number(delta);
  };
  app.scrollTo = ({ top: next = 0 }) => {
    app.scrollTop = Number(next);
  };

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
  feed.scrollBy = ({ top: delta = 0 }) => {
    feed.scrollTop += Number(delta);
  };
  feed.scrollTo = ({ top: next = 0 }) => {
    feed.scrollTop = Number(next);
  };

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
