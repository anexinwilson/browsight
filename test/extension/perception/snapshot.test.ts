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
import { resetIdentity } from "../../../extension/src/perception/identity.ts";
import { buildSnapshot } from "../../../extension/src/perception/snapshot.ts";

test("large snapshots are capped with an explicit truncation marker", () => {
  document.body.innerHTML = Array.from(
    { length: 1200 },
    (_, index) => `<a href="/item-${index}">Unique result ${index} ${"x".repeat(30)}</a>`,
  ).join("");
  const snapshot = buildSnapshot(document);
  assert.ok(snapshot.markdown.length < 25_000);
  assert.match(snapshot.markdown, /snapshot truncated/);
  assert.ok(snapshot.refs.length < 1200);
});

function clearDOM() {
  document.title = "";
  document.body.innerHTML = "";
  // Reference numbering lives for the life of a page, so replacing the document replaces it too.
  resetIdentity();
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

test("main mode focuses the largest primary landmark and keeps actionable references", () => {
  clearDOM();
  document.title = "Mail";
  document.body.innerHTML = `
    <nav>${"Navigation ".repeat(30)}<button>Settings</button></nav>
    <main><h1>Inbox</h1><p>Important message content</p><button>Reply</button></main>
    <aside>${"Advertisement ".repeat(40)}</aside>
  `;

  const snapshot = buildSnapshot(document, { mode: "main" });

  assert.match(snapshot.markdown, /focused on primary content/);
  assert.match(snapshot.markdown, /Important message content/);
  assert.match(snapshot.markdown, /\[button "Reply" #1\]/);
  assert.doesNotMatch(snapshot.markdown, /Settings|Advertisement/);
  assert.equal(snapshot.refs.length, 1);
});

test("main mode explicitly falls back when a page has no primary landmark", () => {
  clearDOM();
  document.body.innerHTML = "<section><p>Useful page content</p></section>";

  const snapshot = buildSnapshot(document, { mode: "main" });

  assert.match(snapshot.markdown, /no primary landmark; showing full page/);
  assert.match(snapshot.markdown, /Useful page content/);
});

test("an active dialog takes priority over background page noise", () => {
  clearDOM();
  document.body.innerHTML = `
    <main>${"Background inbox row ".repeat(200)}<button>Background action</button></main>
    <section role="dialog" aria-modal="true" aria-label="Compose">
      <input aria-label="Recipients">
      <button>Send</button>
    </section>
  `;

  const snapshot = buildSnapshot(document, { mode: "main" });

  assert.match(snapshot.markdown, /focused on active dialog/);
  assert.match(snapshot.markdown, /\[textbox "Recipients" #1\]/);
  assert.match(snapshot.markdown, /\[button "Send" #2\]/);

  // "full" means the whole page: scoping it to the dialog hid everything behind the
  // modal with no way for the caller to know what was missing.
  const whole = buildSnapshot(document, { mode: "full" });
  assert.match(whole.markdown, /a dialog is open over this page/);
  assert.match(whole.markdown, /Background action/);
  assert.doesNotMatch(snapshot.markdown, /Background inbox row|Background action/);
});

test("a non-modal dialog landmark does not hide the rest of the page", () => {
  clearDOM();
  document.body.innerHTML = `
    <header><input aria-label="Search"></header>
    <aside role="dialog"><a href="/filter">Last 30 days</a></aside>
    <main><h1>Results</h1><a href="/book">A new science fiction book</a></main>
  `;

  const snapshot = buildSnapshot(document);

  assert.doesNotMatch(snapshot.markdown, /focused on active dialog/);
  assert.match(snapshot.markdown, /\[textbox "Search" #1\]/);
  assert.match(snapshot.markdown, /A new science fiction book/);
});

test("the focused dialog wins when several compose windows are open", () => {
  clearDOM();
  document.body.innerHTML = `
    <section role="dialog"><input aria-label="First recipient"></section>
    <section role="dialog"><input aria-label="Second recipient"></section>
  `;
  const first = document.querySelector("input[aria-label='First recipient']") as HTMLInputElement;
  first.focus();

  const snapshot = buildSnapshot(document, { mode: "main" });

  assert.match(snapshot.markdown, /focused on active dialog/);
  assert.match(snapshot.markdown, /First recipient/);
  assert.doesNotMatch(snapshot.markdown, /Second recipient/);
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

test("a listing's duplicate image and title links collapse to one marker", () => {
  clearDOM();
  document.body.innerHTML = `
    <div>
      <a href="/p/1"><img alt="Widget Pro"></a>
      <a href="/p/1">Widget Pro</a>
      <a href="/p/2"><img alt="Widget Lite"></a>
      <a href="/p/2">Widget Lite</a>
    </div>
  `;

  const snapshot = buildSnapshot(document);
  const markers = snapshot.markdown.match(/\[link "Widget Pro" #\d+\]/g) ?? [];
  assert.equal(markers.length, 1, "the image link and title link go to the same place");
  assert.match(snapshot.markdown, /\[link "Widget Lite" #\d+\]/);
});

test("a repeated link that points elsewhere is still listed", () => {
  clearDOM();
  document.body.innerHTML = `
    <a href="/a">Details</a>
    <a href="/b">Details</a>
  `;

  const snapshot = buildSnapshot(document);
  const markers = snapshot.markdown.match(/\[link "Details" #\d+\]/g) ?? [];
  assert.equal(markers.length, 2, "same name but different targets are different links");
});

test("main mode drops framing regions when a page has no main landmark", () => {
  clearDOM();
  document.body.innerHTML = `
    <nav><a href="/c1">Category One</a><a href="/c2">Category Two</a></nav>
    <header><a href="/home">Store Home</a></header>
    <div><a href="/result">Actual Result</a></div>
    <aside><a href="/promo">Promoted</a></aside>
  `;

  const main = buildSnapshot(document, { mode: "main" });
  assert.match(main.markdown, /Actual Result/);
  assert.doesNotMatch(main.markdown, /Category One/, "navigation is framing, not content");
  assert.doesNotMatch(main.markdown, /Store Home/);
  assert.doesNotMatch(main.markdown, /Promoted/);

  // "full" still means everything.
  const full = buildSnapshot(document, { mode: "full" });
  assert.match(full.markdown, /Category One/);
  assert.match(full.markdown, /Actual Result/);
});

test("a truncated read reports where to resume, and the next window continues from there", () => {
  clearDOM();
  document.body.innerHTML = Array.from(
    { length: 1200 },
    (_, index) => `<a href="/item-${index}">Unique result ${index} ${"x".repeat(30)}</a>`,
  ).join("");

  const first = buildSnapshot(document);
  assert.equal(first.truncated, true);
  assert.ok(first.nextOffset > 0);
  assert.match(first.markdown, /offset=\d+/);

  const second = buildSnapshot(document, { offset: first.nextOffset });
  assert.match(second.markdown, /continued from offset/);
  // The second window starts where the first stopped rather than repeating it.
  const firstIds = first.refs.map((r) => r.id);
  const secondIds = second.refs.map((r) => r.id);
  assert.ok(secondIds.length > 0);
  assert.equal(
    firstIds.some((id) => secondIds.includes(id)),
    false,
  );
  assert.ok(Math.min(...secondIds) > Math.max(...firstIds));
});

test("reference ids mean the same element whichever window they came from", () => {
  clearDOM();
  document.body.innerHTML = Array.from(
    { length: 1200 },
    (_, index) => `<a href="/item-${index}">Unique result ${index} ${"x".repeat(30)}</a>`,
  ).join("");

  const paged = buildSnapshot(document, { offset: buildSnapshot(document).nextOffset });
  const whole = buildSnapshot(document, { query: "Unique result" });
  for (const ref of paged.refs) {
    const sameId = whole.refs.find((r) => r.id === ref.id);
    if (sameId) {
      assert.equal(sameId.name, ref.name);
    }
  }
});

test("a query searches the whole page, including past where a plain read stops", () => {
  clearDOM();
  document.body.innerHTML = `${Array.from(
    { length: 1200 },
    (_, index) => `<a href="/item-${index}">Filler ${index} ${"x".repeat(30)}</a>`,
  ).join("")}<a href="/needle">Findable needle link</a>`;

  const plain = buildSnapshot(document);
  assert.equal(plain.markdown.includes("Findable needle link"), false);

  const found = buildSnapshot(document, { query: "findable needle" });
  assert.match(found.markdown, /Findable needle link/);
  assert.equal(found.refs.length, 1);
  assert.match(found.markdown, /showing only lines matching/);
});

test("a query that matches nothing returns no references rather than the page", () => {
  clearDOM();
  document.body.innerHTML = `<a href="/a">Alpha</a><a href="/b">Beta</a>`;
  const result = buildSnapshot(document, { query: "nothing here" });
  assert.deepEqual(result.refs, []);
  assert.equal(result.markdown.includes("Alpha"), false);
});

test("a page with no main landmark says so and keeps its real content", () => {
  clearDOM();
  // Regression: an earlier version guessed a stand-in landmark when no `main` was declared. On a
  // storefront the highest-scoring container is often a link-dense sponsored carousel, so the guess
  // returned only ads while still reporting "focused on primary content" — a wrong answer that was
  // indistinguishable from a right one. Reporting the absence honestly is the correct behaviour.
  document.body.innerHTML = `
    <div role="list"><a href="/ad1">Sponsored Ad one</a><a href="/ad2">Sponsored Ad two</a></div>
    <div><a href="/r1">Organic result one</a><a href="/r2">Organic result two</a></div>
  `;
  const result = buildSnapshot(document, { mode: "main" });
  assert.match(result.markdown, /no primary landmark/);
  assert.match(result.markdown, /Organic result one/);
  assert.match(result.markdown, /Sponsored Ad one/);
});

test("a declared main landmark is still trusted and focused", () => {
  clearDOM();
  document.body.innerHTML = `
    <nav><a href="/nav">Navigation link</a></nav>
    <main><a href="/post">Real content post</a></main>
  `;
  const result = buildSnapshot(document, { mode: "main" });
  assert.match(result.markdown, /focused on primary content/);
  assert.match(result.markdown, /Real content post/);
  assert.equal(result.markdown.includes("Navigation link"), false);
});

test("a control keeps its id across reads, whatever the read asks for", () => {
  clearDOM();
  document.body.innerHTML = `
    <nav><a href="/nav">Navigation link</a></nav>
    <main><button>Apply filter</button><a href="/x">Some result</a></main>
  `;
  const idOf = (markdown: string, name: string): string => {
    const marker = `"${name}" #`;
    const at = markdown.indexOf(marker);
    return at === -1 ? "" : (markdown.slice(at + marker.length).split("]")[0] ?? "");
  };

  const full = buildSnapshot(document);
  const main = buildSnapshot(document, { mode: "main" });
  const searched = buildSnapshot(document, { query: "Apply filter" });

  const id = idOf(full.markdown, "Apply filter");
  assert.notEqual(id, "");
  // The same control was previously renumbered by each of these, so a reference taken from one read
  // could act on a different control after another.
  assert.equal(idOf(main.markdown, "Apply filter"), id);
  assert.equal(idOf(searched.markdown, "Apply filter"), id);
});

test("a reference from an earlier read still resolves after a narrower one", async () => {
  clearDOM();
  document.body.innerHTML = `<button>Only button</button><a href="/x">Only link</a>`;
  const { elementForId } = await import("../../../extension/src/perception/identity.ts");

  const full = buildSnapshot(document);
  const linkId = Number(full.markdown.match(/"Only link" #(\d+)/)?.[1]);
  assert.ok(Number.isInteger(linkId));

  // A query read mentions only the button, but the link was numbered earlier and stays resolvable.
  buildSnapshot(document, { query: "Only button" });
  assert.equal(elementForId(linkId)?.textContent, "Only link");
});
