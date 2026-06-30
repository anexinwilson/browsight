## 2026-06-29T23:11:14Z

Your task is to write and enhance unit tests using node:test, assert, and jsdom to achieve >= 80% line coverage for:
1. extension/src/perception/snapshot.ts
2. extension/src/service-worker.ts

DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A Forensic Auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Here are the requirements for each file:

=== 1. extension/src/perception/snapshot.ts ===
Create a new unit test file: `extension/src/perception/snapshot.test.ts`.
Set up a JSDOM environment exposing DOM globals on globalThis:
- window, document, Node, Element, Document, Text, Comment, ShadowRoot, MutationObserver, HTMLInputElement, HTMLTextAreaElement, HTMLSelectElement, HTMLIFrameElement, HTMLElement, Event.
Mock `getBoundingClientRect` globally on the `HTMLElement.prototype` to return non-zero dimensions to avoid `isHidden()` filtering:
```typescript
dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({
  width: 100,
  height: 100,
  top: 0,
  left: 0,
  bottom: 100,
  right: 100,
  x: 0,
  y: 0,
  toJSON: () => {}
}) as any;
Object.defineProperty(dom.window.HTMLElement.prototype, "offsetWidth", { get: () => 100, configurable: true });
Object.defineProperty(dom.window.HTMLElement.prototype, "offsetHeight", { get: () => 100, configurable: true });
```
Implement at least these 15 test cases:
1. Document Title: test `buildSnapshot()` with title present vs absent (doc.title = "Page Title" vs "").
2. Text Normalization: verify whitespace collapsing and digit-sequence pagination pagination stripping.
3. Block Tag Flush: check if tags in BLOCK_TAGS (like div, p, li) flush text to new lines.
4. Skip Tags & Landmarks: verify script, style, noscript, template, svg, footer, and elements with role="contentinfo" are skipped.
5. Hidden Elements: verify display: none, visibility: hidden, aria-hidden="true", inert, and hidden attributes skip elements. Verify display: contents is NOT skipped.
6. Password Fields: verify `<input type="password">` sets hasPasswordField = true in SnapshotResult, while other inputs do not.
7. Interactive Controls: verify buttons/links return `[role "name" #id]` markers, add Ref records, and map to elements.
8. Interactive Composites: verify children of composite interactive elements (like select options) are walked.
9. Name Ordinality: verify that duplicate control names receive incrementing ordinals in their recipe.
10. Element States: verify checked, disabled, etc. are recorded in Ref.state.
11. Heading Handling: verify headings h1-h6 levels generate repeating '#' headers.
12. Heading Deduplication: verify that if a heading matches the preceding interactive element's name, the heading is skipped.
13. Same-Origin Iframe: verify that same-origin contentDocument body elements are traversed.
14. Cross-Origin Iframe: verify that if contentDocument access throws an error (e.g. security block), it outputs `[unreadable frame (cross-origin)]`.
15. Shadow DOM Traversal: verify that open shadowRoot children are walked.

=== 2. extension/src/service-worker.ts ===
Enhance the existing `extension/src/service-worker.test.ts` file to add the following test cases for missing branches:
1. Fetch failure in `loadConnection()`: mock fetch to throw or return invalid JSON, assert loadConnection returns null.
2. connect() duplicate socket: call connect() when socket is already active/connecting, assert it exits early and does not create a second socket.
3. connect() empty connection: when loadConnection returns null, verify it exits early.
4. connect() disallowed host: connection specifies host not in ALLOWED_WS_HOSTS (e.g., example.com), verify connection exits early.
5. connect() invalid port: connection specifies port out of [1, 65535] or non-number, verify connection exits early.
6. ws.message origin mismatch: trigger message event with origin "ws://evil.com", verify route() is not called.
7. route() parse error: message data is invalid JSON or violates BridgeMessageSchema, verify it is caught and handled without throwing.
8. extension runtime lifecycle: trigger `chrome.runtime.onInstalled` and `chrome.runtime.onStartup` callback listeners, assert they trigger connect().

=== Verification ===
1. Verify all tests pass by executing `npm run test` or `node --experimental-test-coverage --test "**/*.test.ts"`.
2. Check that the line coverage for both `extension/src/perception/snapshot.ts` and `extension/src/service-worker.ts` is >= 80%.
3. Write your handoff report (e.g. `handoff.md`) in your working directory and notify the orchestrator.
