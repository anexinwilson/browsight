# Analysis Report: Extension Test Coverage and Recommendations

This report documents the current test coverage analysis for five target files in the `extension/` directory of the `browsight` repository:
1. `extension/src/content.ts`
2. `extension/src/messaging/act.ts`
3. `extension/src/messaging/common.ts`
4. `extension/src/messaging/tabs.ts`
5. `extension/src/acting/act.ts`

---

## 1. Test Suite & Coverage Measurement Overview

### How Tests are Run
The test suite utilizes the native Node.js test runner. The command configured in the root `package.json` is:
```json
"test": "node --test \"**/*.test.ts\""
```
Running `npm run test` executes all test files matching `**/*.test.ts`.

### How Coverage is Measured
Coverage is measured natively via Node.js's experimental coverage feature. The command to run tests with coverage is:
```bash
node --experimental-test-coverage --test "**/*.test.ts"
```
Running this command produces a detailed per-file coverage report (Line %, Branch %, Functions %, and uncovered line ranges).

### Current Test Suite Output
All 52 existing tests pass successfully. Running the coverage command yields the following metrics for the target files:

| File | Line % | Branch % | Funcs % | Uncovered Lines |
|---|---|---|---|---|
| `extension/src/content.ts` | 0% | 0% | 0% | Entire file (untested) |
| `extension/src/messaging/act.ts` | 33.33% | 28.57% | 33.33% | 19-60, 65-67, 72-79, 82-83, 102-132, 135-144 |
| `extension/src/messaging/common.ts` | 96.77% | 80.00% | 83.33% | 53-54 |
| `extension/src/messaging/tabs.ts` | 62.07% | 33.33% | 40.00% | 21-22, 37-52, 55-64, 71-75 |
| `extension/src/acting/act.ts` | 96.92% | 84.62% | 100.00% | 28-29, 237-238, 251-252, 258-259, 261-262 |

---

## 2. File-by-File Code and Coverage Analysis

### 1. `extension/src/content.ts`
* **Type**: Content script (executed in the tab's page context).
* **Exports**: None (executes side-effects).
* **Functions & Main Blocks**:
  * Side-effect guard: `if (!globalThis.__browsightInjected)` sets the injection marker and registers the listener.
  * Message listener: `chrome.runtime.onMessage.addListener(...)`
    * Handles `"read"` message:
      * Calls `buildSnapshot(document)`
      * Calls `rememberSnapshot(snap.refs, snap.elements)`
      * Computes page load marker: `Math.round(performance.timeOrigin)`
      * Invokes `sendResponse(...)` and returns `false` (synchronous).
    * Handles `"act"` message (requires `message.ref` and `message.action`):
      * Calls async `performAct(...)`
      * Invokes `sendResponse(...)` when resolved, returns `true` (asynchronous).
    * Fallback: returns `false`.
* **Coverage Gaps**: 100% uncovered. No test file targets this script.
* **Testing Strategy & Scenarios**:
  * **Mocking**:
    * Global `chrome.runtime.onMessage.addListener` to capture the callback.
    * `document` object via `jsdom` (or mock the return of `buildSnapshot`).
    * `performance.timeOrigin` (e.g. set `globalThis.performance = { timeOrigin: 1000 } as any`).
  * **Scenarios**:
    * **Scenario 1 (Double Injection Guard)**: Verify `globalThis.__browsightInjected` is set to `true` on load. Import/evaluating the file twice should only register the listener once.
    * **Scenario 2 ("read" Message)**: Trigger the listener with `{ kind: "read" }`. Verify it calls `buildSnapshot` and `rememberSnapshot`, formats the response with `page-load:1000`, and returns `false`.
    * **Scenario 3 ("act" Message)**: Trigger the listener with `{ kind: "act", ref: "1", action: "click" }`. Verify it returns `true` and calls `performAct` with the correct parameters, sending the result to `sendResponse` when resolved.
    * **Scenario 4 (Default/Unknown Message)**: Trigger the listener with `{ kind: "unknown" }`. Verify it returns `false` and doesn't invoke any callbacks.

---

### 2. `extension/src/messaging/act.ts`
* **Type**: Service worker action messaging handler.
* **Exports**:
  * `handleAct(send: Send, msg: ActRequest): Promise<void>`
* **Internal Functions**:
  * `handleNavigate(send: Send, id: string, value: string | undefined, tabId: number, grants: Grant[], now: number): Promise<void>`
  * `sendActSentinel(send: Send, id: string, kind: SentinelKind, hint: string): void`
* **Coverage Gaps**: Uncovered lines are 19-60, 65-67, 72-79, 82-83, 102-132, 135-144. These correspond to all sentinel emissions, navigation handling, and error catching.
* **Testing Strategy & Scenarios**:
  * **Mocking**:
    * Chrome APIs: `chrome.tabs.reload`, `chrome.tabs.update`, `chrome.scripting.executeScript`, `chrome.tabs.sendMessage`.
    * Dependencies: `currentTab()`, `listGrants()` (from `./common.ts` / `./permissions/storage.ts`).
  * **Scenarios**:
    * **Scenario 1 (No Active Tab)**: Mock `currentTab` to return `undefined`. Verify `handleAct` sends `frame_unreachable` sentinel.
    * **Scenario 2 (Origin Not Whitelisted)**: Mock a tab with origin `https://malicious.com` not in whitelisted grants. Verify `handleAct` sends `not_whitelisted` sentinel.
    * **Scenario 3 (Navigation Action)**:
      * **3a (Reload)**: Trigger with `action: "navigate", value: "reload"`. Verify `chrome.tabs.reload` is called and returns `"navigated"` verdict.
      * **3b (Missing URL)**: Trigger with `action: "navigate", value: undefined`. Verify it returns `not_actionable` sentinel.
      * **3c (Unwhitelisted Destination)**: Trigger with `action: "navigate", value: "https://unauthorized.com"`. Verify it returns `not_whitelisted` sentinel.
      * **3d (Whitelisted Destination)**: Trigger with `action: "navigate", value: "https://authorized.com"`. Verify `chrome.tabs.update` is called and returns `"navigated"` verdict.
    * **Scenario 4 (Script Execute / SendMessage Errors)**:
      * **4a (Navigated Away during click/fill)**: Mock `sendMessage` to throw `"message channel closed"`.
        * If target tab navigated to a *non-whitelisted* origin, verify it sends `not_whitelisted` sentinel.
        * If target tab navigated to a *whitelisted* origin, verify it sends a clean `"navigated"` verdict.
      * **4b (General Error)**: Mock `sendMessage` to throw a general error (e.g. `"execution failed"`). Verify it sends `frame_unreachable` sentinel with the error message.

---

### 3. `extension/src/messaging/common.ts`
* **Type**: Tab and session state helpers.
* **Exports**:
  * Type `Send`
  * Interface `ContentReadResult`
  * `focusedTab(): Promise<chrome.tabs.Tab | undefined>`
  * `setCurrentTab(tabId: number): Promise<void>`
  * `currentTab(): Promise<chrome.tabs.Tab | undefined>`
  * `originOf(url: string): string`
  * `readTabContent(tabId: number): Promise<ContentReadResult>`
* **Coverage Gaps**: Lines 53-54 (the catch block inside `originOf` when URL parsing fails).
* **Testing Strategy & Scenarios**:
  * **Mocking**:
    * Chrome APIs: `chrome.tabs.query`, `chrome.tabs.get`, `chrome.storage.session.get`, `chrome.storage.session.set`, `chrome.scripting.executeScript`, `chrome.tabs.sendMessage`.
  * **Scenarios**:
    * **Scenario 1 (Invalid URL Origin)**: Call `originOf("invalid-url-string")`. Verify it catches the error and returns `"invalid-url-string"` (covers line 53-54).
    * **Scenario 2 (Focused Tab)**: Call `focusedTab()`. Verify it queries `chrome.tabs.query` with `{ active: true, lastFocusedWindow: true }` and returns the first element.
    * **Scenario 3 (Current Tab resolution)**:
      * **3a (No session tab)**: Mock session storage to return no value. Verify `currentTab()` falls back to calling `focusedTab()`.
      * **3b (Session tab valid)**: Session storage has tab ID `1`, and `chrome.tabs.get(1)` succeeds. Verify `currentTab()` returns that tab.
      * **3c (Session tab closed)**: Session storage has tab ID `1`, but `chrome.tabs.get(1)` throws. Verify it falls back to `focusedTab()`.
    * **Scenario 4 (Read Tab Content)**: Call `readTabContent(1)`. Verify it runs `chrome.scripting.executeScript` and sends `"read"` message.

---

### 4. `extension/src/messaging/tabs.ts`
* **Type**: Service worker tab-management messaging handler.
* **Exports**:
  * `handleTabs(send: Send, msg: TabsRequest): Promise<void>`
* **Internal Functions**:
  * `sendTabs(send: Send, id: string, tabs: TabInfo[], sentinel?: Sentinel): void`
* **Coverage Gaps**: Uncovered lines are 21-22, 37-52, 55-64, 71-75. These correspond to filtering non-http tabs, resolving selectors, performing the switch/window updates, and catching read errors.
* **Testing Strategy & Scenarios**:
  * **Mocking**:
    * Chrome APIs: `chrome.tabs.query`, `chrome.tabs.update`, `chrome.windows.update`.
    * Helpers: `listGrants`, `currentTab`, `setCurrentTab`, `readTabContent`, `resolveTabSelection`.
  * **Scenarios**:
    * **Scenario 1 (List Tabs - No Selection)**: Call `handleTabs` with no `msg.select`.
      * Mock `chrome.tabs.query` to return multiple tabs (some http/https, some `chrome://extensions` or `about:blank`).
      * Verify the returned list contains only HTTP/HTTPS tabs, indicates active status properly, and includes correct permission labels.
    * **Scenario 2 (Select - Sentinel Resolution)**: Call `handleTabs` with `msg.select = "ambiguous"`. Mock `resolveTabSelection` to return a sentinel. Verify the sentinel is attached to the output response.
    * **Scenario 3 (Select - Successful Switch)**: Call `handleTabs` with `msg.select = "reddit"`.
      * Mock `resolveTabSelection` to return a valid tab with ID `1` and `windowId: 10`.
      * Verify it updates the tab (`chrome.tabs.update`) and window (`chrome.windows.update`).
      * Verify it records the tab selection (`setCurrentTab`) and reads content (`readTabContent`).
      * Verify the sent response contains switchedTo status and the markdown content.
    * **Scenario 4 (Select - Switch / Read Failure)**: Mock `chrome.tabs.update` or `readTabContent` to throw an error. Verify it sends a response with a `frame_unreachable` sentinel containing the error message.

---

### 5. `extension/src/acting/act.ts`
* **Type**: DOM manipulation and action-execution coordination.
* **Exports**:
  * `fillValue(...)`, `fillSelect(...)`, `fillEditable(...)`, `dispatchClick(...)`, `performAct(...)`
* **Internal Functions**:
  * `interactiveCount()`, `scrollingRoot()`, `scrollViewport(...)`, `settleAndReport(...)`, `loadMore()`, `handleViewportScroll(...)`, `tryPerformFill(...)`
* **Coverage Gaps**: Uncovered lines are 28-29, 237-238, 251-252, 258-259, 261-262.
* **Testing Strategy & Scenarios**:
  * **Mocking**:
    * Extend the existing `extension/src/acting/act.test.ts` setup which already uses `jsdom` to mock DOM classes.
  * **Scenarios**:
    * **Scenario 1 (Fill Select)**: Execute `performAct("1", "fill", "v1")` where ref `"1"` resolves to an `HTMLSelectElement`. This covers `tryPerformFill` calling `fillSelect`.
    * **Scenario 2 (Fill ContentEditable)**: Execute `performAct("2", "fill", "text")` where ref `"2"` resolves to a contenteditable `HTMLElement`. This covers `tryPerformFill` calling `fillEditable`.
    * **Scenario 3 (Undefined Value for Fill)**: Execute `tryPerformFill(el, undefined, before)` directly in unit tests to cover the early return `{ kind: "ignored" }` (line 251-252).
    * **Scenario 4 (Viewport Scroll DOM Changed)**: Mock `scrollViewport` such that scrolling results in a DOM change (verdict is not `"no_change"`). Verify it hits line 237-238.
    * **Scenario 5 (Missing Value Setter Descriptor)**: Mock a text input element that does not have a setter property descriptor for `"value"` on its prototype. Run `fillValue` to verify it hits the fallback assignment `el.value = value` (line 28-29).

---

## 3. General Recommendations & Test Layout Compliance

1. **Create Dedicated Test Files**:
   * Create `extension/src/messaging/act.test.ts` to test the action handler.
   * Create `extension/src/messaging/tabs.test.ts` to test the tab management.
   * Create `extension/src/content.test.ts` to test the content script side-effects and message handling.
2. **Expand Existing Tests**:
   * Add the missing edge cases for `common.ts` in one of the existing or new tests.
   * Append the select, contenteditable, scroll-change, and fallback-descriptor test cases to `extension/src/acting/act.test.ts`.
3. **Follow Layout Compliance**:
   * Keep the test files co-located with their source files (e.g. `extension/src/messaging/act.test.ts` next to `extension/src/messaging/act.ts`). Do not place code/test files under `.agents/`.
4. **Execution Command**:
   * Run tests with coverage reporting via:
     ```bash
     node --experimental-test-coverage --test "**/*.test.ts"
     ```
