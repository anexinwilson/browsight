import assert from "node:assert";
import test from "node:test";
import { JSDOM } from "jsdom";

// Setup global DOM mocks before importing act.ts
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
const gThis = globalThis as unknown as Record<string, unknown>;
const w = dom.window as unknown as Record<string, unknown>;
gThis.window = dom.window;
gThis.document = dom.window.document;
gThis.Node = dom.window.Node;
gThis.Element = dom.window.Element;
gThis.Document = dom.window.Document;
gThis.Text = dom.window.Text;
gThis.Comment = dom.window.Comment;
gThis.ShadowRoot = dom.window.ShadowRoot || class {};
gThis.MutationObserver = dom.window.MutationObserver;
gThis.HTMLInputElement = dom.window.HTMLInputElement;
gThis.HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
gThis.HTMLSelectElement = dom.window.HTMLSelectElement;
gThis.HTMLIFrameElement = dom.window.HTMLIFrameElement;
gThis.HTMLElement = dom.window.HTMLElement;
gThis.Event = dom.window.Event;

// Mock getBoundingClientRect globally for all HTMLElements to avoid JSDOM layout 0x0 size issues.
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
  }) as any;
Object.defineProperty(dom.window.HTMLElement.prototype, "offsetWidth", {
  get: () => 100,
  configurable: true,
});
Object.defineProperty(dom.window.HTMLElement.prototype, "offsetHeight", {
  get: () => 100,
  configurable: true,
});

// JSDOM has InputEvent and MouseEvent but PointerEvent might be missing or fail if view is globalThis.
const OriginalPointerEvent = dom.window.PointerEvent || dom.window.MouseEvent || dom.window.Event;
gThis.PointerEvent = class PointerEvent extends (OriginalPointerEvent as any) {
  constructor(type: string, init?: any) {
    if (init && init.view === globalThis) {
      init.view = dom.window;
    }
    super(type, init);
  }
};

const OriginalMouseEvent = dom.window.MouseEvent || dom.window.Event;
gThis.MouseEvent = class MouseEvent extends (OriginalMouseEvent as any) {
  constructor(type: string, init?: any) {
    if (init && init.view === globalThis) {
      init.view = dom.window;
    }
    super(type, init);
  }
};

gThis.InputEvent = dom.window.InputEvent || dom.window.Event;

// Now import the modules
import { dispatchClick, fillEditable, fillSelect, fillValue, performAct } from "./act.ts";
import { rememberSnapshot } from "./resolve.ts";

if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = () => {};
}

test("fillValue sets value and fires events on text input", () => {
  const input = document.createElement("input");
  input.type = "text";
  document.body.appendChild(input);

  let inputFired = 0;
  let changeFired = 0;
  let blurFired = 0;

  input.addEventListener("input", () => inputFired++);
  input.addEventListener("change", () => changeFired++);
  input.addEventListener("blur", () => blurFired++);

  fillValue(input, "hello");

  assert.strictEqual(input.value, "hello");
  assert.strictEqual(inputFired, 1);
  assert.strictEqual(changeFired, 1);
  assert.strictEqual(blurFired, 1);
  input.remove();
});

test("fillValue sets value and fires events on textarea", () => {
  const textarea = document.createElement("textarea");
  document.body.appendChild(textarea);

  let inputFired = 0;
  let changeFired = 0;

  textarea.addEventListener("input", () => inputFired++);
  textarea.addEventListener("change", () => changeFired++);

  fillValue(textarea, "world");

  assert.strictEqual(textarea.value, "world");
  assert.strictEqual(inputFired, 1);
  assert.strictEqual(changeFired, 1);
  textarea.remove();
});

test("fillSelect selects options and fires events", () => {
  const select = document.createElement("select");
  const opt1 = document.createElement("option");
  opt1.value = "v1";
  opt1.label = "lbl1";
  opt1.text = "txt1";
  select.appendChild(opt1);

  const opt2 = document.createElement("option");
  opt2.value = "v2";
  opt2.text = "txt2";
  select.appendChild(opt2);
  document.body.appendChild(select);

  let inputFired = 0;
  let changeFired = 0;
  select.addEventListener("input", () => inputFired++);
  select.addEventListener("change", () => changeFired++);

  // Try non-matching option
  const ok1 = fillSelect(select, "non-existent");
  assert.strictEqual(ok1, false);

  // Select by value
  const ok2 = fillSelect(select, "v1");
  assert.strictEqual(ok2, true);
  assert.strictEqual(select.value, "v1");
  assert.strictEqual(inputFired, 1);
  assert.strictEqual(changeFired, 1);

  // Select by label
  const ok3 = fillSelect(select, "lbl1");
  assert.strictEqual(ok3, true);

  // Select by text
  const ok4 = fillSelect(select, "txt2");
  assert.strictEqual(ok4, true);
  assert.strictEqual(select.value, "v2");

  select.remove();
});

test("fillEditable replaces contenteditable text and fires InputEvents", () => {
  const div = document.createElement("div");
  div.setAttribute("contenteditable", "true");
  document.body.appendChild(div);

  let beforeInputFired = 0;
  let inputFired = 0;
  let beforeInputData = "";
  let inputData = "";

  div.addEventListener("beforeinput", (e: any) => {
    beforeInputFired++;
    beforeInputData = e.data;
  });
  div.addEventListener("input", (e: any) => {
    inputFired++;
    inputData = e.data;
  });

  const ok = fillEditable(div, "new content");
  assert.strictEqual(ok, true);
  assert.strictEqual(div.textContent, "new content");
  assert.strictEqual(beforeInputFired, 1);
  assert.strictEqual(beforeInputData, "new content");
  assert.strictEqual(inputFired, 1);
  assert.strictEqual(inputData, "new content");

  div.remove();
});

test("dispatchClick dispatches Pointer and Mouse events", () => {
  const btn = document.createElement("button");
  document.body.appendChild(btn);

  let clickFired = false;
  let pointerDownFired = false;
  btn.addEventListener("click", () => {
    clickFired = true;
  });
  btn.addEventListener("pointerdown", () => {
    pointerDownFired = true;
  });

  dispatchClick(btn);

  assert.strictEqual(clickFired, true);
  assert.strictEqual(pointerDownFired, true);
  btn.remove();
});

test("scrollingViewport scrolls top, bottom, up, down", async () => {
  const root = document.scrollingElement || document.documentElement;
  let currentScrollTop = 100;

  Object.defineProperty(root, "scrollTop", {
    get() {
      return currentScrollTop;
    },
    set(v) {
      currentScrollTop = v;
    },
    configurable: true,
  });
  Object.defineProperty(root, "scrollHeight", {
    get() {
      return 1000;
    },
    configurable: true,
  });
  Object.defineProperty(root, "clientHeight", {
    get() {
      return 200;
    },
    configurable: true,
  });

  const originalScrollTo = root.scrollTo;
  const originalScrollBy = root.scrollBy;

  root.scrollTo = (opt: any) => {
    if (typeof opt.top === "number") {
      currentScrollTop = opt.top;
    }
  };
  root.scrollBy = (opt: any) => {
    if (typeof opt.top === "number") {
      currentScrollTop += opt.top;
    }
  };

  try {
    const resBottom = await performAct("", "scroll", "bottom");
    assert.strictEqual(currentScrollTop, 1000);

    const resTop = await performAct("", "scroll", "top");
    assert.strictEqual(currentScrollTop, 0);

    const resDown = await performAct("", "scroll", "down");
    assert.strictEqual(currentScrollTop, 200);

    const resUp = await performAct("", "scroll", "up");
    assert.strictEqual(currentScrollTop, 0);
  } finally {
    root.scrollTo = originalScrollTo;
    root.scrollBy = originalScrollBy;
  }
});

test("loadMore processes scroll down and handles outcomes", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  // Use a minimal macrotask delay (0ms) so that assignments execute before setTimeout callbacks.
  (globalThis as any).setTimeout = (cb: any, ms: any) => originalSetTimeout(cb, 0);

  const root = document.scrollingElement || document.documentElement;
  let currentScrollTop = 0;
  let moves = 0;

  Object.defineProperty(root, "scrollTop", {
    get() {
      return currentScrollTop;
    },
    set(v) {
      currentScrollTop = v;
    },
    configurable: true,
  });
  Object.defineProperty(root, "clientHeight", {
    get() {
      return 200;
    },
    configurable: true,
  });

  const originalScrollBy = root.scrollBy;
  const addedElements: HTMLElement[] = [];

  try {
    // 1. Success: new content appears
    root.scrollBy = (opt: any) => {
      currentScrollTop += 100;
      moves++;
      if (moves === 2) {
        const btn = document.createElement("button");
        btn.id = "new-btn";
        btn.textContent = "New button";
        document.body.appendChild(btn);
        addedElements.push(btn);
      }
    };
    const resSuccess = await performAct("", "scroll", "more");
    assert.strictEqual(resSuccess.verdict, "dom_changed");
    assert.ok(resSuccess.refs.length > 0);

    // Clean up elements and reset
    for (const el of addedElements) el.remove();
    addedElements.length = 0;
    currentScrollTop = 0;
    moves = 0;

    // 2. Reached bottom (movedPx === 0)
    root.scrollBy = (opt: any) => {
      // do not change scrollTop (movedPx is 0)
    };
    const resBottom = await performAct("", "scroll", "more");
    assert.strictEqual(resBottom.verdict, "no_change");
    assert.strictEqual(resBottom.sentinel?.kind, "not_actionable");
    assert.match(resBottom.sentinel?.hint || "", /reached the bottom/);

    // 3. No new content after max steps
    currentScrollTop = 0;
    root.scrollBy = (opt: any) => {
      currentScrollTop += 100;
    };
    const resNoChange = await performAct("", "scroll", "more");
    assert.strictEqual(resNoChange.verdict, "no_change");
    assert.match(resNoChange.sentinel?.hint || "", /paged \d+ screens/);
  } finally {
    (globalThis as any).setTimeout = originalSetTimeout;
    root.scrollBy = originalScrollBy;
  }
});

test("performAct executes various cases and validation paths", async () => {
  const btn = document.createElement("button");
  document.body.appendChild(btn);
  rememberSnapshot([], new Map([[1, btn]]));

  // click action
  const resClick = await performAct("1", "click");
  assert.strictEqual(resClick.verdict, "no_change"); // JSDOM click did not mutate DOM

  // fill text action on a button (non-fillable element)
  rememberSnapshot([], new Map([[1, btn]]));
  const resFillButton = await performAct("1", "fill", "text");
  assert.strictEqual(resFillButton.verdict, "no_change");
  assert.strictEqual(resFillButton.sentinel?.kind, "not_actionable");
  assert.match(resFillButton.sentinel?.hint || "", /can't be filled/);

  // fill text action on text input
  const input = document.createElement("input");
  input.type = "text";
  document.body.appendChild(input);
  rememberSnapshot([], new Map([[2, input]]));
  const resFillInput = await performAct("2", "fill", "val");
  assert.strictEqual(input.value, "val");

  // scroll action
  let scrollCalled = false;
  btn.scrollIntoView = () => {
    scrollCalled = true;
  };
  rememberSnapshot([], new Map([[1, btn]]));
  await performAct("1", "scroll");
  assert.strictEqual(scrollCalled, true);

  // navigate action
  rememberSnapshot([], new Map([[1, btn]]));
  const resNav = await performAct("1", "navigate");
  assert.ok(resNav);

  // invalid/stale ref validation path
  const resStale = await performAct("999", "click");
  assert.strictEqual(resStale.verdict, "no_change");
  assert.strictEqual(resStale.sentinel?.kind, "ref_stale");

  btn.remove();
  input.remove();
});
