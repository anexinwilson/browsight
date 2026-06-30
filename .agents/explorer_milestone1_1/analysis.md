# Analysis of browsight-mcp Codebase (Milestone 1)

## Executive Summary
This report documents the diagnostic check results, test coverage metrics, and SonarCloud code smell findings for the `browsight-mcp` repository. All 37 existing tests pass and typecheck compiles successfully. However, Biome check reveals 15 style/lint errors (mostly around test mocks and formatting). Specific recommendations are provided to resolve cognitive complexity, accessibility issues, and test coverage gaps.

---

## 1. Diagnostic Checks & Command Results

### 1.1 Typecheck
* **Command**: `npm run typecheck`
* **Result**: `SUCCESS` (Exit code: 0)
* **Details**: TypeScript compiler checked all workspaces (`@browsight/shared`, `@browsight/server`, `@browsight/extension`, `@browsight/scripts`) without any errors.

### 1.2 Lint (Biome Check)
* **Command**: `npm run lint` (runs `biome check .`)
* **Result**: `FAILED` (Exit code: 1, 15 errors found)
* **Errors Catalog**:
  1. **`package.json`**: Formatting mismatch (specifically, formatting of arrays like `keywords`, `files`, and `workspaces`).
  2. **`extension/src/acting/act.test.ts`**:
     - **10 Suspicious Any Warnings (`lint/suspicious/noExplicitAny`)**: Occur on lines 7, 8, 9, 10, 11, 12, 13, 15, 16, and 17 where JSDOM globals are attached to `globalThis` (e.g. `(globalThis as any).window = dom.window`).
     - **Import Sorting**: `import assert` and `import test` imports are unsorted on lines 1-2.
     - **Formatting**: Line 17 violates standard formatting rules.
  3. **`extension/src/perception/snapshot.ts`**:
     - **Formatting**: Line 68 return statement formatting mismatch.

### 1.3 Test Execution & Coverage Baseline
* **Command**: `node --experimental-test-coverage --test "**/*.test.ts"`
* **Result**: `SUCCESS` (37 tests passed, 0 failed)
* **Coverage Matrix**:

| File Path | Line % | Branch % | Functions % | Uncovered Lines |
|---|---|---|---|---|
| `extension/src/service-worker.ts` | **0.00%** | **0.00%** | **0.00%** | All lines (1-120) |
| `extension/src/acting/act.ts` | **27.39%** | **83.33%** | **8.33%** | 28-29, 37-47, 51-65, 83-85, 88-90, 95-107, 117-145, 148-161, 170-211, 213-240, 244-303 |
| `scripts/setup.ts` | **73.48%** | **65.85%** | **84.21%** | 111-122, 124-134, 143-144, 148-149, 158, 190-218, 222, 227-229 |
| `extension/src/acting/diff.ts` | 97.14% | 92.31% | 100.00% | 43-44 |
| `extension/src/acting/resolve.ts` | 30.66% | 100.00% | 0.00% | 23-27, 31-34, 38-40, 44-69, 77-85, 90-137 |
| `extension/src/acting/settle.ts` | 19.23% | 100.00% | 0.00% | 6-26 |
| `extension/src/messaging/tab-select.ts` | 100.00% | 100.00% | 100.00% | None |
| `extension/src/perception/accessibility.ts` | 46.43% | 100.00% | 0.00% | 10-15, 19-24, 28-33, 51-70, 78-84 |
| `extension/src/perception/dom.ts` | 53.33% | 100.00% | 0.00% | 34-54, 58-62, 67-75 |
| `extension/src/perception/recipe.ts` | 30.43% | 100.00% | 0.00% | 8-23 |
| `extension/src/perception/snapshot.ts` | 27.80% | 50.00% | 0.00% | 39-46, 50-51, 54-69, 72-82, 85-110, 113-136, 139-151, 154-199, 204-205 |
| `extension/src/permissions/policy.ts` | 100.00% | 100.00% | 100.00% | None |
| `server/src/bridge.ts` | 84.71% | 76.92% | 75.00% | 63-65, 74-75, 83-84, 92, 109-112, 128-129, 143-151, 154-156 |
| `server/src/extract.ts` | 100.00% | 90.91% | 100.00% | None |
| `server/src/tabs.ts` | 100.00% | 85.71% | 100.00% | None |
| `shared/src/protocol.ts` | 100.00% | 100.00% | 100.00% | None |

---

## 2. SonarCloud Code Smell Investigation

### 2.1 Use of `window` vs `globalThis`
* **Target Files**: `extension/src/content.ts` and `extension/src/acting/act.ts`
* **Observations**:
  - `extension/src/content.ts` contains **no** occurrences of `window`. It references `globalThis.__browsightInjected` and `performance.timeOrigin`.
  - `extension/src/acting/act.ts` contains **no** active references to the global `window` object. On line 98, it correctly uses `globalThis.innerHeight`. On line 124, it passes `globalThis as unknown as Window` for the `view` property in `MouseEventInit`.
* **Conclusion**: Both files are already compliant. No changes are required.

### 2.2 Functions with High Cognitive Complexity
* **`extension/src/acting/act.ts`**:
  - **`performAct` (Lines 243-303)**: Moderate cognitive complexity due to:
    - Early returns on viewport scroll and reference resolution checks.
    - A `switch(action)` block where the `"fill"` case contains nested `if-else if-else` conditions checking element classes (`HTMLInputElement`, `HTMLSelectElement`, etc.) with further early returns.
  - **Recommendation**: Extract the `"fill"` case logic into a helper function `performFill(el: Element, value: string): boolean`.
* **`extension/src/perception/snapshot.ts`**:
  - **`walk` (Lines 153-199)**: Extremely high cognitive complexity (>15).
    - Reasons: Contains deep recursive calls, sequential conditional statements with complex boolean checks (`SKIP_TAGS.has(tag) || isHidden(el)`), custom handlers, element-type specific state mutations (password checking), and nested loops (for traversing children and shadow roots).
  - **Recommendation**: Split `walk` into:
    - A guard helper function `shouldSkipNode(node: Node): boolean`
    - Node-type specific dispatch handlers (e.g., `handleHeading`, `handleIframe`, `handleInteractive`)
    - A cleaner tree-traversal recursion method.

### 2.3 HTML Standards Compliance (`options.html` and `popup.html`)
* **`extension/src/options.html`** (located at `extension/src/options.html`):
  - **Smells**:
    - The inputs/selects on lines 31-36:
      ```html
      <input id="origin" placeholder="https://example.com" aria-label="Origin URL" />
      <select id="tier" aria-label="Access Tier">...</select>
      <select id="timer" aria-label="Expiration Timer"></select>
      ```
      These use `aria-label` but have no associated `<label>` element. SonarCloud accessibility checks commonly flag inputs lacking explicit `<label>` tags.
  - **Recommendation**: Add a `<label for="...">` element for each of these controls (can be marked visually hidden if design dictates).
* **`extension/src/popup.html`** (located at `extension/src/popup.html`):
  - **Smells**:
    - The buttons on lines 28-29 are wrapped in a `div` containing `aria-labelledby="access-lbl"`. This is technically valid, but ensure no additional accessibility rules are broken.
    - The select `#timer` on line 32 has both `<label for="timer">Allow for</label>` on line 31 and an `aria-label="Expiration Timer"` attribute. This is valid but redundant.

### 2.4 Top-Level Await Warnings (SonarCloud S7785)
* **Context**: S7785 prefers top-level await in ECMAScript modules.
* **Findings**:
  - `extension/src/popup.ts`, `extension/src/options.ts`, and `extension/src/content.ts` are compiled to the **IIFE format** by esbuild (`format: "iife"` in `extension/build.mjs`).
  - Standard IIFE bundles do not support top-level `await` at the language level; doing so breaks compilation.
  - These files correctly implement the `async function init() { ... }` + `void init()` pattern to handle async initialization.
  - S7785 alerts on these specific files are **false positives** and should be resolved by marking them as "False Positive" in the SonarCloud dashboard rather than modifying the code.
  - Conversely, `extension/src/service-worker.ts` is compiled as ESM (`format: "esm"`) and correctly utilizes top-level `await connect();` on line 119.

---

## 3. Test Setup & Mocking Investigation

### 3.1 Test Framework and execution
* **Engine**: Node.js v24.12.0 native test runner. Runs `.ts` files directly in-memory via Node's native strip-types support.
* **Command**: `node --test "**/*.test.ts"`

### 3.2 Mocking Environment
* **JSDOM Mocks**: The DOM testing environment is manually initialized inside `extension/src/acting/act.test.ts` (lines 3-17) by constructing a `JSDOM` object and assigning its components (like `window`, `document`, `HTMLElement`, `InputEvent`, `MouseEvent`, `PointerEvent`) directly to `globalThis`.
* **Network Mocks**: Sockets are verified using local loopback `ws` connections on test-dedicated ports.

### 3.3 Target Coverage Gaps & Recommendations

#### A. `extension/src/service-worker.ts` (0% coverage)
* **Gap**: Not tested because it relies on Chrome Extension runtime APIs (`chrome.runtime`, `chrome.alarms`) and a live WebSocket server.
* **Recommendation**: Create a mock test environment (e.g. `extension/src/service-worker.test.ts`) that mocks the global `chrome` namespace (specifically `chrome.runtime.onInstalled`, `chrome.runtime.onStartup`, `chrome.runtime.getURL`, `chrome.alarms`) and provides a mock WebSocket server to verify connection behavior and message routing.

#### B. `extension/src/acting/act.ts` (27.39% coverage)
* **Gap**: Functions like `fillSelect`, `fillEditable`, `scrollViewport`, `dispatchClick`, `loadMore`, and `performAct` are completely untested.
* **Recommendation**: Expand `act.test.ts` to cover these:
  1. Add tests for `fillSelect` using `document.createElement("select")` with options.
  2. Add tests for `fillEditable` using elements with `contenteditable="true"`.
  3. Mock `HTMLElement.prototype.getBoundingClientRect` and `Element.prototype.dispatchEvent` to verify click dispatching details in `dispatchClick`.
  4. Mock scrolling properties (`scrollingElement.scrollTop`, `clientHeight`, `scrollHeight`) and methods (`scrollTo`, `scrollBy`) to test viewport scrolling and `loadMore` state transitions.

#### C. `scripts/setup.ts` (73.48% coverage)
* **Gap**: CLI commands `runSetup` and `runDoctor`, and port conflict resolutions (`tryPort`, `pickPort`) are untested.
* **Recommendation**: Add a test script for testing the runner logic by:
  1. Mocking `process.stdout.write` and `process.stderr.write` to assert correct outputs.
  2. Mocking `node:net`'s `createServer` to simulate port-busy and port-free environments to verify port extraction.
