import assert from "node:assert";
import test, { mock } from "node:test";
import { JSDOM } from "jsdom";

// 1. Setup JSDOM
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;

// 2. Mock performance.timeOrigin
Object.defineProperty(performance, "timeOrigin", {
  value: 99999,
  configurable: true,
  writable: true,
});

// 3. Mock chrome.runtime.onMessage.addListener
const listeners: any[] = [];
const chromeMock: any = {
  runtime: {
    onMessage: {
      addListener: (cb: any) => {
        listeners.push(cb);
      },
    },
  },
};
(globalThis as any).chrome = chromeMock;

// 4. Mock the dependencies of content.ts via global hooks
const performActMock = mock.fn(async (ref: string, action: string, value?: string) => {
  return {
    verdict: "dom_changed" as any,
    diff: { appeared: [], removed: [], changed: [] },
    refs: [],
  };
});

const rememberSnapshotMock = mock.fn((refs: any[], elements: any) => {});

const buildSnapshotMock = mock.fn((doc: any) => {
  return {
    markdown: "Mocked Page Content",
    refs: [{ id: 1, role: "button", name: "Click Me" }],
    elements: new Map(),
    hasPasswordField: false,
  };
});

(globalThis as any).__mockPerformAct = performActMock;
(globalThis as any).__mockRememberSnapshot = rememberSnapshotMock;
(globalThis as any).__mockBuildSnapshot = buildSnapshotMock;

// Reset the global injection guard if it was somehow set
(globalThis as any).__browsightInjected = undefined;

// 5. Import the content script
await import("./content.ts");

test("content.ts double-injection guard", async () => {
  // Verify __browsightInjected is set to true
  assert.strictEqual((globalThis as any).__browsightInjected, true);

  // Verify only one listener is registered
  const initialListenerCount = listeners.length;
  assert.strictEqual(initialListenerCount, 1);
});

test("content.ts handles 'read' message", () => {
  const listener = listeners[0];
  let response: any = null;
  const sendResponse = (res: any) => {
    response = res;
  };

  // Triggers listener for "read"
  const result = listener({ kind: "read" }, {}, sendResponse);

  assert.strictEqual(result, false, "'read' message should return false");
  assert.ok(buildSnapshotMock.mock.calls.length > 0);
  assert.ok(rememberSnapshotMock.mock.calls.length > 0);
  assert.strictEqual(
    response.markdown,
    "<!-- page-load:99999 (changes on reload/navigate) -->\nMocked Page Content",
  );
  assert.deepEqual(response.refs, [{ id: 1, role: "button", name: "Click Me" }]);
  assert.strictEqual(response.hasPasswordField, false);
});

test("content.ts handles 'act' message", async () => {
  const listener = listeners[0];
  let response: any = null;
  const sendResponse = (res: any) => {
    response = res;
  };

  // Triggers listener for "act"
  const result = listener(
    { kind: "act", ref: "btn-1", action: "click", value: "val-1" },
    {},
    sendResponse,
  );

  assert.strictEqual(result, true, "'act' message should return true");

  // Wait for the async performAct promise to resolve and invoke sendResponse
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.ok(performActMock.mock.calls.length > 0);
  assert.deepEqual(performActMock.mock.calls[0].arguments, ["btn-1", "click", "val-1"]);
  assert.strictEqual(response.verdict, "dom_changed");
});

test("content.ts ignores unknown or incomplete messages", () => {
  const listener = listeners[0];
  let response: any = null;
  const sendResponse = (res: any) => {
    response = res;
  };

  // Unknown message kind
  const res1 = listener({ kind: "unknown" }, {}, sendResponse);
  assert.strictEqual(res1, false);
  assert.strictEqual(response, null);

  // Incomplete 'act' message (missing action/ref)
  const res2 = listener({ kind: "act", ref: "btn-1" }, {}, sendResponse);
  assert.strictEqual(res2, false);
  assert.strictEqual(response, null);
});
