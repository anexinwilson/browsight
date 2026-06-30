# Test Coverage and Mocking Analysis

This report documents the investigation of the test configuration and coverage analysis for two key files in the `browsight` extension: `extension/src/perception/snapshot.ts` and `extension/src/service-worker.ts`.

---

## 1. Analysis of `extension/src/perception/snapshot.ts`

`extension/src/perception/snapshot.ts` contains the logic for building a semantic snapshot of the DOM in document order, representing interactive elements, headings, text content, and structure. Currently, there are **no direct tests** for this file.

To achieve `>=80%` test coverage (specifically targeting 100% of all branches), we need to write unit tests using `jsdom`.

### What Needs to be Mocked (using JSDOM)

1. **JSDOM Environment Setup**:
   A mock DOM environment must be created. We must expose standard window globals on `globalThis` so the snapshot builder and its helpers can access them:
   - `window`, `document`, `Node`, `Element`, `HTMLElement`, `HTMLInputElement`, `HTMLTextAreaElement`, `HTMLSelectElement`, `HTMLIFrameElement`.

2. **`getBoundingClientRect` and layout dimensions**:
   - **Reason**: The helper function `isHidden` in `extension/src/perception/dom.ts` checks the dimensions of elements:
     ```typescript
     const rect = (el as HTMLElement).getBoundingClientRect?.();
     return rect ? rect.width === 0 && rect.height === 0 : false;
     ```
   - **Mocking Strategy**: Since JSDOM does not implement a layout engine, `getBoundingClientRect` returns `0` width and height by default. This makes `isHidden` classify every element as hidden and causes the snapshot builder to skip them. We must mock `getBoundingClientRect` on the prototype:
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
     ```
     Also, mock `offsetWidth` and `offsetHeight` if needed:
     ```typescript
     Object.defineProperty(dom.window.HTMLElement.prototype, "offsetWidth", { get: () => 100 });
     Object.defineProperty(dom.window.HTMLElement.prototype, "offsetHeight", { get: () => 100 });
     ```

3. **Iframe Document Isolation & Errors**:
   - **Reason**: The `handleIframe` function accesses `el.contentDocument` inside a `try/catch` block to handle cross-origin iframe security exceptions.
   - **Mocking Strategy**:
     - *Same-origin iframe*: An iframe element where `contentDocument.body` contains nodes to walk.
     - *Cross-origin iframe*: An iframe where accessing `contentDocument` throws an exception (e.g. `SecurityError`) or returns `null`. This can be mocked by overriding the property getter on a specific iframe:
       ```typescript
       Object.defineProperty(iframe, "contentDocument", {
         get() { throw new Error("SecurityError: Blocked frame from accessing cross-origin frame."); }
       });
       ```

4. **Shadow DOM (Native JSDOM Support)**:
   - JSDOM supports `element.attachShadow({ mode: 'open' })`. No special stub is needed, but the tests must attach shadow roots to verify that `walkChildren` traverses them.

5. **CSS Visibility / Display**:
   - To verify style-based hiding (`display: none` and `visibility: hidden`), we can set `el.style.display = "none"` or `el.style.visibility = "hidden"`. JSDOM's native `window.getComputedStyle(el)` will reflect this.

---

### Test Cases Required for >=80% Coverage

To ensure all branches are thoroughly covered, the following test cases should be implemented:

| Test Case | Target Code Branch / Logic | Expected Output / Behavior |
|---|---|---|
| **1. Document Title** | Title present vs absent (`this.doc.title`) | If title is `"My Page"`, output starts with `# My Page`. If title is empty, no header is emitted. |
| **2. Text Normalization** | Whitespace collapsing and pagination stripping | Collapse multiple spaces, tabs, and newlines. Strip digit sequences like ` 1 2 3 4 5 6 7 8 `. |
| **3. Block Tag Flush** | `BLOCK_TAGS` (`div`, `p`, `li`, etc.) | Ensure tags in `BLOCK_TAGS` cause the current text line to be flushed and wrapped onto a new line. |
| **4. Skip Tags & Landmarks** | `SKIP_TAGS` and `footer`/`role="contentinfo"` | Verify that `script`, `style`, `noscript`, `template`, `svg`, `footer`, and `[role="contentinfo"]` are skipped. |
| **5. Hidden Elements** | `isHidden` helper combinations | Verify elements with `hidden`, `aria-hidden="true"`, `inert` properties, or styles `display: none`/`visibility: hidden` are skipped. Verify that `display: contents` is NOT skipped. |
| **6. Password Fields** | `isPasswordField` check | Ensure `<input type="password">` sets `hasPasswordField = true` in the result metadata, and normal inputs do not. |
| **7. Interactive Controls** | `handleInteractive` for buttons, links, etc. | Check that interactive elements produce `[role "name" #id]` markers, add `Ref` records, and map to `elements`. |
| **8. Interactive Composites** | `isComposite` elements (`select`, `[contenteditable]`) | Verify that children of composite interactive elements (like options in select) are traversed and recorded, rather than skipped. |
| **9. Name Ordinality** | Duplicate control names | Check that multiple buttons with the same name and role receive incrementing ordinals in their recipe. |
| **10. Element States** | `elementState` retrieval | Check that active element states (e.g. `checked`, `disabled`) are captured and stored in the `Ref.state`. |
| **11. Heading Handling** | `handleHeading` levels (`h1` through `h6`) | Verify correct markdown symbols (e.g. `## Heading Text`). |
| **12. Heading Deduplication** | Heading matching last interactive name | Verify that if a heading's text matches the name of the immediately preceding interactive element, the heading is skipped to avoid redundancy. |
| **13. Same-Origin Iframe** | `handleIframe` (readable) | Verify that the walker traverses inside the iframe's body and includes its text. |
| **14. Cross-Origin Iframe** | `handleIframe` (unreadable / throwing error) | Verify that the output includes the text `[unreadable frame (cross-origin)]`. |
| **15. Shadow DOM Traversal** | `walkChildren` shadowRoot traversal | Verify that elements inside an open shadow root are crawled and output correctly. |

---

## 2. Analysis of `extension/src/service-worker.ts`

### Current Test Execution and Coverage Results
Running the existing test suite using `npm run test` yields **52 passing tests**. The specific metrics for `service-worker.ts` from Node's native coverage runner are:
- **Line Coverage**: `85.83%`
- **Branch Coverage**: `60.87%`
- **Function Coverage**: `83.33%`

### Missing Branches and Conditions
To achieve `>=80%` branch coverage, the following uncovered lines and conditions must be addressed:

#### 1. `loadConnection()` catch block (lines 38-41)
- **Code**:
  ```typescript
  try {
    const res = await fetch(chrome.runtime.getURL("connection.json"));
    ...
  } catch {
    // Not set up yet — `npm run setup` writes connection.json.
  }
  return null;
  ```
- **Scenario to cover**: The fetch request to `"connection.json"` fails (e.g., file not found, network error, or JSON is malformed).
- **How to test**: Mock `fetch` to reject or return an invalid JSON structure, and verify that `loadConnection()` returns `null` gracefully.

#### 2. `connect()` early return on active/connecting socket (lines 45-47)
- **Code**:
  ```typescript
  if (socket && socket.readyState <= WebSocket.OPEN) {
    return;
  }
  ```
- **Scenario to cover**: Calling `connect()` when a WebSocket is already connected or in the process of connecting.
- **How to test**: Assert that calling `connect()` twice in a row does not instantiate a second `WebSocket` object.

#### 3. `connect()` early return on empty connection configuration (lines 49-51)
- **Code**:
  ```typescript
  const conn = await loadConnection();
  if (!conn) {
    return;
  }
  ```
- **Scenario to cover**: Calling `connect()` when `loadConnection()` returns `null`.
- **How to test**: Trigger `connect()` with a failing fetch mock, and assert that no `WebSocket` is created.

#### 4. `connect()` early return on unauthorized host (lines 53-56)
- **Code**:
  ```typescript
  const safeHost = ALLOWED_WS_HOSTS.find((h) => h === conn.host);
  if (!safeHost) {
    return;
  }
  ```
- **Scenario to cover**: `connection.json` specifies a host that is not local (e.g. `"malicious.com"`).
- **How to test**: Mock `connection.json` to return `{ host: "example.com", port: 8080, token: "tok" }`, call `connect()`, and assert that no WebSocket connection is attempted.

#### 5. `connect()` early return on invalid port ranges (lines 58-61)
- **Code**:
  ```typescript
  const safePort = Number.parseInt(String(conn.port), 10);
  if (Number.isNaN(safePort) || safePort < 1 || safePort > 65535) {
    return;
  }
  ```
- **Scenario to cover**: `connection.json` specifies a port that is not a valid number, or is outside the range `[1, 65535]`.
- **How to test**: Mock `connection.json` with `port: -1` or `port: "invalid"`, call `connect()`, and assert that no WebSocket is created.

#### 6. `ws.message` origin check mismatch (lines 78-80)
- **Code**:
  ```typescript
  ws.addEventListener("message", (ev) => {
    const expectedOrigin = `ws://${safeHost}:${safePort}`;
    if (ev.origin === expectedOrigin) {
      void route(String(ev.data));
    } else {
      return;
    }
  });
  ```
- **Scenario to cover**: The WebSocket client receives a message event whose `origin` property does not match `ws://<host>:<port>`.
- **How to test**: Trigger a message event on the mock WebSocket with `origin: "ws://attacker.com"`, and verify that `route()` is not called (the message is ignored).

#### 7. `route()` parsing catch block (lines 97-99)
- **Code**:
  ```typescript
  try {
    msg = BridgeMessageSchema.parse(JSON.parse(raw));
  } catch {
    return;
  }
  ```
- **Scenario to cover**: Receiving a websocket message that is either invalid JSON or does not conform to the expected message schema.
- **How to test**: Trigger a message event with `data: "{invalid-json}"` or `data: '{"type": "unknown.type"}'`, and verify that the parser catches the error and returns early without throwing or crashing.

#### 8. Chrome extension lifecycle events (lines 110 & 113)
- **Code**:
  ```typescript
  chrome.runtime.onInstalled.addListener(() => {
    void connect();
  });
  chrome.runtime.onStartup.addListener(() => {
    void connect();
  });
  ```
- **Scenario to cover**: The extension is installed or the browser starts up.
- **How to test**: Manually invoke the registered callbacks for `chrome.runtime.onInstalled` and `chrome.runtime.onStartup`, and verify that `connect()` is executed.
