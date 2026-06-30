import assert from "node:assert";
import test from "node:test";
import { JSDOM } from "jsdom";

// Setup global DOM mocks before importing snapshot.ts
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
const gThis = globalThis as unknown as Record<string, unknown>;
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

// Import the module under test
import { buildSnapshot } from "./snapshot.ts";

function clearDOM() {
  document.title = "";
  document.body.innerHTML = "";
}

test("Document Title: test buildSnapshot() with title present vs absent", () => {
  clearDOM();
  document.title = "Page Title";
  document.body.innerHTML = "<div>Hello</div>";
  const snap1 = buildSnapshot(document);
  assert.ok(snap1.markdown.includes("# Page Title"));

  document.title = "";
  const snap2 = buildSnapshot(document);
  assert.ok(!snap2.markdown.includes("#"));
  assert.strictEqual(snap2.markdown, "Hello");
});

test("Text Normalization: verify whitespace collapsing and digit-sequence pagination stripping", () => {
  clearDOM();
  document.body.innerHTML = "<div>Hello    \n\r\t   World</div>";
  let snap = buildSnapshot(document);
  assert.strictEqual(snap.markdown, "Hello World");

  // Digit pagination sequence: "1 2 3 4 5 6 7 8 9"
  document.body.innerHTML = "<div> 1 2 3 4 5 6 7 8 9 </div>";
  snap = buildSnapshot(document);
  assert.strictEqual(snap.markdown, "");
});

test("Block Tag Flush: check if tags in BLOCK_TAGS (like div, p, li) flush text to new lines", () => {
  clearDOM();
  document.body.innerHTML = "<div>Line 1</div><p>Line 2</p><li>Line 3</li>";
  const snap = buildSnapshot(document);
  assert.strictEqual(snap.markdown, "Line 1\nLine 2\nLine 3");
});

test("Skip Tags & Landmarks: verify script, style, noscript, template, svg, footer, and elements with role='contentinfo' are skipped", () => {
  clearDOM();
  document.body.innerHTML = `
    <div>Visible</div>
    <script>const x = 1;</script>
    <style>body { color: red; }</style>
    <noscript>No Script</noscript>
    <template><p>Template Content</p></template>
    <svg><rect/></svg>
    <footer>Footer Content</footer>
    <div role="contentinfo">Content Info</div>
  `;
  const snap = buildSnapshot(document);
  assert.strictEqual(snap.markdown, "Visible");
});

test("Hidden Elements: verify display: none, visibility: hidden, aria-hidden='true', inert, and hidden attributes skip elements. Verify display: contents is NOT skipped", () => {
  clearDOM();
  document.body.innerHTML = `
    <div>Visible</div>
    <div hidden>Hidden attr</div>
    <div aria-hidden="true">Aria hidden</div>
    <div style="display: none;">Display none</div>
    <div style="visibility: hidden;">Visibility hidden</div>
    <div id="inert-div">Inert div</div>
    <div style="display: contents;">Contents element</div>
  `;

  const inertDiv = document.getElementById("inert-div") as any;
  if (inertDiv) {
    inertDiv.inert = true;
  }

  const snap = buildSnapshot(document);
  assert.ok(snap.markdown.includes("Visible"));
  assert.ok(!snap.markdown.includes("Hidden attr"));
  assert.ok(!snap.markdown.includes("Aria hidden"));
  assert.ok(!snap.markdown.includes("Display none"));
  assert.ok(!snap.markdown.includes("Visibility hidden"));
  assert.ok(!snap.markdown.includes("Inert div"));
  assert.ok(snap.markdown.includes("Contents element"));
});

test("Password Fields: verify <input type='password'> sets hasPasswordField = true in SnapshotResult, while other inputs do not", () => {
  clearDOM();
  document.body.innerHTML = `<input type="text" name="username">`;
  let snap = buildSnapshot(document);
  assert.strictEqual(snap.hasPasswordField, false);

  document.body.innerHTML = `<input type="password" name="pass">`;
  snap = buildSnapshot(document);
  assert.strictEqual(snap.hasPasswordField, true);
});

test("Interactive Controls: verify buttons/links return [role 'name' #id] markers, add Ref records, and map to elements", () => {
  clearDOM();
  document.body.innerHTML = `
    <button id="btn1">Click Me</button>
    <a href="https://example.com" id="lnk1">Visit Link</a>
  `;
  const snap = buildSnapshot(document);
  assert.ok(snap.markdown.includes('[button "Click Me" #1]'));
  assert.ok(snap.markdown.includes('[link "Visit Link" #2]'));

  assert.strictEqual(snap.refs.length, 2);
  assert.strictEqual(snap.refs[0].id, 1);
  assert.strictEqual(snap.refs[0].role, "button");
  assert.strictEqual(snap.refs[0].name, "Click Me");

  assert.strictEqual(snap.refs[1].id, 2);
  assert.strictEqual(snap.refs[1].role, "link");
  assert.strictEqual(snap.refs[1].name, "Visit Link");

  assert.strictEqual(snap.elements.get(1), document.getElementById("btn1"));
  assert.strictEqual(snap.elements.get(2), document.getElementById("lnk1"));
});

test("Interactive Composites: verify children of composite interactive elements (like select options) are walked", () => {
  clearDOM();
  document.body.innerHTML = `
    <select id="sel">
      <option value="opt1">Option 1</option>
      <option value="opt2">Option 2</option>
    </select>
  `;
  const snap = buildSnapshot(document);
  assert.ok(snap.markdown.includes("Option 1"));
  assert.ok(snap.markdown.includes("Option 2"));
});

test("Name Ordinality: verify that duplicate control names receive incrementing ordinals in their recipe", () => {
  clearDOM();
  document.body.innerHTML = `
    <button>Submit</button>
    <button>Submit</button>
  `;
  const snap = buildSnapshot(document);
  assert.strictEqual(snap.refs.length, 2);
  assert.strictEqual(snap.refs[0].recipe.ordinal, 0);
  assert.strictEqual(snap.refs[1].recipe.ordinal, 1);
});

test("Element States: verify checked, disabled, etc. are recorded in Ref.state", () => {
  clearDOM();
  document.body.innerHTML = `
    <input type="checkbox" id="chk1" checked>
    <input type="text" id="txt1" disabled value="some value">
    <button id="btn" aria-pressed="true">Pressed</button>
  `;
  const snap = buildSnapshot(document);

  const chkRef = snap.refs.find((r) => r.role === "checkbox");
  assert.ok(chkRef?.state?.includes("checked=true"));

  const btnRef = snap.refs.find((r) => r.name === "Pressed");
  assert.ok(btnRef?.state?.includes("aria-pressed=true"));
});

test("Heading Handling: verify headings h1-h6 levels generate repeating '#' headers", () => {
  clearDOM();
  document.body.innerHTML = `
    <h1>Header 1</h1>
    <h2>Header 2</h2>
    <h3>Header 3</h3>
    <h4>Header 4</h4>
    <h5>Header 5</h5>
    <h6>Header 6</h6>
  `;
  const snap = buildSnapshot(document);
  assert.strictEqual(
    snap.markdown,
    "# Header 1\n## Header 2\n### Header 3\n#### Header 4\n##### Header 5\n###### Header 6",
  );
});

test("Heading Deduplication: verify that if a heading matches the preceding interactive element's name, the heading is skipped", () => {
  clearDOM();
  document.body.innerHTML = `
    <button>Submit</button>
    <h2>Submit</h2>
  `;
  const snap = buildSnapshot(document);
  assert.strictEqual(snap.markdown, '[button "Submit" #1]');
});

test("Same-Origin Iframe: verify that same-origin contentDocument body elements are traversed", () => {
  clearDOM();
  document.body.innerHTML = `<iframe id="iframe1"></iframe>`;
  const iframe = document.getElementById("iframe1") as HTMLIFrameElement;

  const mockIframeDoc = dom.window.document.implementation.createHTMLDocument("Iframe Doc");
  mockIframeDoc.body.innerHTML = "<div>Iframe Content</div>";

  Object.defineProperty(iframe, "contentDocument", {
    get() {
      return mockIframeDoc;
    },
    configurable: true,
  });

  const snap = buildSnapshot(document);
  assert.ok(snap.markdown.includes("Iframe Content"));
});

test("Cross-Origin Iframe: verify that if contentDocument access throws an error (e.g. security block), it outputs [unreadable frame (cross-origin)]", () => {
  clearDOM();
  document.body.innerHTML = `<iframe id="iframe2"></iframe>`;
  const iframe = document.getElementById("iframe2") as HTMLIFrameElement;

  Object.defineProperty(iframe, "contentDocument", {
    get() {
      throw new Error("SecurityError: Blocked cross-origin access");
    },
    configurable: true,
  });

  const snap = buildSnapshot(document);
  assert.ok(snap.markdown.includes("[unreadable frame (cross-origin)]"));
});

test("Shadow DOM Traversal: verify that open shadowRoot children are walked", () => {
  clearDOM();
  document.body.innerHTML = `<div id="shadow-host">Light Content</div>`;
  const host = document.getElementById("shadow-host") as HTMLElement;
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = "<div>Shadow Content</div>";

  const snap = buildSnapshot(document);
  assert.ok(snap.markdown.includes("Light Content"));
  assert.ok(snap.markdown.includes("Shadow Content"));
});
