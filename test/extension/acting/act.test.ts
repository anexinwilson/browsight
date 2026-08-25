import assert from "node:assert";
import test from "node:test";
import { JSDOM } from "jsdom";

// Setup global DOM mocks before importing act.ts
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
const gThis = globalThis as unknown as Record<string, unknown>;
const _w = dom.window as unknown as Record<string, unknown>;
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

// jsdom supplies all of these. Subclassing only to redirect `view` from the Node global to the
// jsdom window, which jsdom rejects. Substituting a different event class when one is missing would
// let a click test silently exercise MouseEvent and pass while PointerEvent support was broken, so
// each shim extends the real constructor and nothing else.
const withJsdomView = <T extends new (type: string, init?: any) => Event>(Base: T) =>
  class extends (Base as new (type: string, init?: any) => Event) {
    constructor(type: string, init?: any) {
      super(type, init && init.view === globalThis ? { ...init, view: dom.window } : init);
    }
  };

gThis.PointerEvent = withJsdomView(dom.window.PointerEvent);
gThis.MouseEvent = withJsdomView(dom.window.MouseEvent);
gThis.InputEvent = dom.window.InputEvent;

import { performAct, performBatchFill } from "../../../extension/src/acting/act.ts";
import { selectVerdict } from "../../../extension/src/acting/diff.ts";
import {
  dispatchClick,
  dispatchEnter,
  fillEditable,
  fillSelect,
  fillValue,
} from "../../../extension/src/acting/input.ts";
import { rememberSnapshot, resolveRef } from "../../../extension/src/acting/resolve.ts";
// Now import the modules
import { idFor, resetIdentity } from "../../../extension/src/perception/identity.ts";
import { buildSnapshot } from "../../../extension/src/perception/snapshot.ts";

/**
 * Give the named elements the ids the test expects. Numbering is owned by the page-wide registry
 * now, so a test asks for `#1` by being the first element registered rather than by writing into a
 * map, which is also what proves the ids a real read hands out are the ones an action resolves.
 */
function seedRefs(wanted: Record<number, Element>): void {
  resetIdentity();
  const highest = Math.max(...Object.keys(wanted).map(Number));
  for (let id = 1; id <= highest; id++) {
    idFor(wanted[id] ?? document.createElement("span"));
  }
}

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

test("fillValue uses the owning frame realm for same-origin inputs", () => {
  const iframe = document.createElement("iframe");
  document.body.appendChild(iframe);
  const frameDocument = iframe.contentDocument;
  assert.ok(frameDocument);
  const input = frameDocument.createElement("input");
  frameDocument.body.appendChild(input);
  let beforeInputFired = 0;
  let inputFired = 0;
  input.addEventListener("beforeinput", () => beforeInputFired++);
  input.addEventListener("input", () => inputFired++);

  fillValue(input, "inside frame");

  assert.equal(input.value, "inside frame");
  assert.equal(beforeInputFired, 1);
  assert.equal(inputFired, 1);
  iframe.remove();
});

test("reference fallback descends into same-origin frame documents", () => {
  const iframe = document.createElement("iframe");
  document.body.appendChild(iframe);
  const frameDocument = iframe.contentDocument;
  assert.ok(frameDocument);
  const button = frameDocument.createElement("button");
  button.textContent = "Frame action";
  button.getBoundingClientRect = () => ({ width: 100, height: 30 }) as DOMRect;
  frameDocument.body.appendChild(button);
  rememberSnapshot([
    {
      id: 91,
      role: "button",
      name: "Frame action",
      recipe: {
        role: "button",
        name: "Frame action",
        dataAttrs: {},
        text: "Frame action",
        ordinal: 0,
      },
    },
  ]);

  const resolution = resolveRef("91");
  assert.ok("el" in resolution);
  assert.equal(resolution.el, button);
  iframe.remove();
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
    const _resBottom = await performAct("", "scroll", "bottom");
    assert.strictEqual(currentScrollTop, 1000);

    const _resTop = await performAct("", "scroll", "top");
    assert.strictEqual(currentScrollTop, 0);

    const _resDown = await performAct("", "scroll", "down");
    assert.strictEqual(currentScrollTop, 160);

    const _resUp = await performAct("", "scroll", "up");
    assert.strictEqual(currentScrollTop, 0);
  } finally {
    root.scrollTo = originalScrollTo;
    root.scrollBy = originalScrollBy;
  }
});

test("loadMore processes scroll down and handles outcomes", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  // Use a minimal macrotask delay (0ms) so that assignments execute before setTimeout callbacks.
  (globalThis as any).setTimeout = (cb: any, _ms: any) => originalSetTimeout(cb, 0);

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
    root.scrollBy = (_opt: any) => {
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
    root.scrollBy = (_opt: any) => {
      // do not change scrollTop (movedPx is 0)
    };
    const resBottom = await performAct("", "scroll", "more");
    assert.strictEqual(resBottom.verdict, "no_change");
    assert.strictEqual(resBottom.sentinel?.kind, "not_actionable");
    assert.match(resBottom.sentinel?.hint || "", /reached the bottom/);

    // 3. No new content after max steps
    currentScrollTop = 0;
    root.scrollBy = (_opt: any) => {
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
  seedRefs({ 1: btn });
  rememberSnapshot([]);

  // click action
  const resClick = await performAct("1", "click");
  assert.strictEqual(resClick.verdict, "no_change"); // JSDOM click did not mutate DOM
  // A bare "no_change" cannot be acted on: it does not say whether the reference was
  // dud, the control inert, or the result opened elsewhere.
  assert.ok(resClick.sentinel, "no_change must explain itself");
  assert.match(resClick.sentinel?.hint ?? "", /did not change/);
  assert.match(resClick.sentinel?.hint ?? "", /browser_tabs/);

  // fill text action on a button (non-fillable element)
  seedRefs({ 1: btn });
  rememberSnapshot([]);
  const resFillButton = await performAct("1", "fill", "text");
  assert.strictEqual(resFillButton.verdict, "no_change");
  assert.strictEqual(resFillButton.sentinel?.kind, "not_actionable");
  assert.match(resFillButton.sentinel?.hint || "", /can't be filled/);

  // fill text action on text input
  const input = document.createElement("input");
  input.type = "text";
  document.body.appendChild(input);
  seedRefs({ 2: input });
  rememberSnapshot([]);
  const _resFillInput = await performAct("2", "fill", "val");
  assert.strictEqual(input.value, "val");

  // scroll action
  let scrollCalled = false;
  btn.scrollIntoView = () => {
    scrollCalled = true;
  };
  seedRefs({ 1: btn });
  rememberSnapshot([]);
  await performAct("1", "scroll");
  assert.strictEqual(scrollCalled, true);

  // navigate action
  seedRefs({ 1: btn });
  rememberSnapshot([]);
  const resNav = await performAct("1", "navigate");
  assert.ok(resNav);

  // invalid/stale ref validation path
  const resStale = await performAct("999", "click");
  assert.strictEqual(resStale.verdict, "no_change");
  assert.strictEqual(resStale.sentinel?.kind, "ref_stale");

  btn.remove();
  input.remove();
});

test("performAct with a select element calls fillSelect through tryPerformFill", async () => {
  const select = document.createElement("select");
  const opt = document.createElement("option");
  opt.value = "v1";
  opt.text = "txt1";
  select.appendChild(opt);
  document.body.appendChild(select);

  seedRefs({ 1: select });
  rememberSnapshot([]);
  const res = await performAct("1", "fill", "v1");
  assert.strictEqual(select.value, "v1");
  assert.strictEqual(res.verdict, "value_set");

  select.remove();
});

test("performAct with a contenteditable element calls fillEditable through tryPerformFill", async () => {
  const div = document.createElement("div");
  div.setAttribute("contenteditable", "true");
  Object.defineProperty(div, "isContentEditable", {
    get() {
      return true;
    },
    configurable: true,
  });
  document.body.appendChild(div);

  seedRefs({ 1: div });
  rememberSnapshot([]);
  const res = await performAct("1", "fill", "helloeditable");
  assert.strictEqual(div.textContent, "helloeditable");
  assert.strictEqual(res.verdict, "value_set");

  div.remove();
});

test("fill without a value leaves the page unchanged", async () => {
  const input = document.createElement("input");
  input.type = "text";
  document.body.appendChild(input);

  seedRefs({ 1: input });
  rememberSnapshot([]);
  const res = await performAct("1", "fill", undefined);
  assert.strictEqual(res.verdict, "no_change");

  input.remove();
});

test("viewport scroll reports content loaded during the scroll", async () => {
  const root = document.scrollingElement || document.documentElement;
  let currentScrollTop = 0;

  Object.defineProperty(root, "scrollTop", {
    get() {
      return currentScrollTop;
    },
    set(v) {
      currentScrollTop = v;
    },
    configurable: true,
  });

  const originalScrollBy = root.scrollBy;
  const addedElements: HTMLElement[] = [];

  root.scrollBy = (_opt: any) => {
    currentScrollTop += 100; // movedPx !== 0
    const btn = document.createElement("button");
    btn.id = "scroll-dom-change-btn";
    btn.textContent = "Scroll DOM Change Button";
    document.body.appendChild(btn);
    addedElements.push(btn);
  };

  try {
    const res = await performAct("", "scroll", "down");
    assert.strictEqual(res.verdict, "dom_changed");
    assert.strictEqual(res.sentinel, undefined);
  } finally {
    root.scrollBy = originalScrollBy;
    for (const el of addedElements) {
      el.remove();
    }
  }
});

test("fillValue falls back when the prototype has no value setter", () => {
  const input = document.createElement("input");
  input.type = "text";
  document.body.appendChild(input);

  const originalDescriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");

  try {
    // Simulate a host environment that does not expose the native setter.
    Object.defineProperty(HTMLInputElement.prototype, "value", {
      value: "",
      writable: true,
      configurable: true,
    });

    fillValue(input, "fallback-value");
    assert.strictEqual(input.value, "fallback-value");
  } finally {
    if (originalDescriptor) {
      Object.defineProperty(HTMLInputElement.prototype, "value", originalDescriptor);
    }
    input.remove();
  }
});

test("a fill that submits reports the navigation, a plain fill still short-circuits", () => {
  // Plain fill: no page comparison happens, so the verdict is value_set.
  assert.strictEqual(selectVerdict("fill", "a", "a", true, false), "value_set");
  // Same fill, but the Enter left the page: the URL change outranks value_set.
  assert.strictEqual(selectVerdict("fill", "a", "b", true, true), "navigated");
  // Submitted without leaving the page (an in-place search) still reports the DOM change.
  assert.strictEqual(selectVerdict("fill", "a", "b", false, false), "dom_changed");
  assert.strictEqual(selectVerdict("click", "a", "a", false, true), "navigated");
});

test("Enter submits the owning form, and a page that cancels the key stops it", () => {
  const dom = new JSDOM(
    `<form id="f"><input id="q" type="text"><button type="submit">Go</button></form>
     <form id="g"><input id="r" type="text"><button type="submit">Go</button></form>
     <textarea id="t"></textarea>`,
  );
  const d = dom.window.document;
  const submitted: string[] = [];
  for (const id of ["f", "g"]) {
    const form = d.getElementById(id) as HTMLFormElement;
    form.requestSubmit = () => {
      submitted.push(id);
    };
  }

  dispatchEnter(d.getElementById("q") as HTMLInputElement);
  assert.deepStrictEqual(submitted, ["f"], "a plain Enter submits the enclosing form");

  // A page that handles Enter itself must be able to stop the default submission.
  const r = d.getElementById("r") as HTMLInputElement;
  r.addEventListener("keydown", (e) => {
    e.preventDefault();
  });
  dispatchEnter(r);
  assert.deepStrictEqual(submitted, ["f"], "preventDefault on keydown suppresses the submit");

  // Enter in a textarea is a newline, never a submit.
  dispatchEnter(d.getElementById("t") as HTMLTextAreaElement);
  assert.deepStrictEqual(submitted, ["f"], "a textarea never submits");
});

test("a javascript: link gets the click event but not the blocked navigation", () => {
  const dom = new JSDOM(
    `<a id="js" href="javascript:void(0)">go</a>
     <a id="real" href="/somewhere">go</a>
     <button id="btn">go</button>`,
  );
  const d = dom.window.document;
  const activated: string[] = [];
  const clicked: string[] = [];

  for (const id of ["js", "real", "btn"]) {
    const el = d.getElementById(id) as HTMLElement;
    el.click = () => {
      activated.push(id);
    };
    el.addEventListener("click", () => {
      clicked.push(id);
    });
  }

  dispatchClick(d.getElementById("js") as HTMLElement);
  assert.deepStrictEqual(clicked, ["js"], "the click event still reaches the page");
  assert.deepStrictEqual(activated, [], "the CSP-blocked activation is not attempted");

  // A real destination and a plain button keep their native activation.
  dispatchClick(d.getElementById("real") as HTMLElement);
  dispatchClick(d.getElementById("btn") as HTMLElement);
  assert.deepStrictEqual(activated, ["real", "btn"], "normal elements still activate natively");
});

test("a batch fill fills every field in one pass and settles once", async () => {
  const d = gThis.document as Document;
  d.body.innerHTML = `
    <form>
      <input id="name" type="text">
      <input id="email" type="text">
      <textarea id="cover"></textarea>
    </form>`;

  const snap = buildSnapshot(d);
  rememberSnapshot(snap.refs, snap.markdown, snap.signature);
  const refFor = (name: string) =>
    String(snap.refs.find((r) => r.name === name || r.recipe?.name === name)?.id ?? "");

  const ids = snap.refs.map((r) => String(r.id));
  const result = await performBatchFill([
    { ref: ids[0] as string, value: "Ada" },
    { ref: ids[1] as string, value: "ada@example.com" },
    { ref: ids[2] as string, value: "Hello" },
  ]);

  void refFor;
  assert.strictEqual((d.getElementById("name") as HTMLInputElement).value, "Ada");
  assert.strictEqual((d.getElementById("email") as HTMLInputElement).value, "ada@example.com");
  assert.strictEqual((d.getElementById("cover") as HTMLTextAreaElement).value, "Hello");
  assert.strictEqual(result.sentinel, undefined, "every field filled, so no sentinel");
});

test("a batch fill reports the fields it could not fill without abandoning the rest", async () => {
  const d = gThis.document as Document;
  d.body.innerHTML = `<form><input id="only" type="text"></form>`;
  const snap = buildSnapshot(d);
  rememberSnapshot(snap.refs, snap.markdown, snap.signature);

  const result = await performBatchFill([
    { ref: String(snap.refs[0]?.id), value: "kept" },
    { ref: "9999", value: "no such control" },
  ]);

  assert.strictEqual((d.getElementById("only") as HTMLInputElement).value, "kept");
  assert.ok(result.sentinel, "the caller is told something was missed");
  assert.match(result.sentinel?.hint ?? "", /filled 1 of 2/);
  assert.match(result.sentinel?.hint ?? "", /#9999/);
});
