import assert from "node:assert";
import test, { mock } from "node:test";
import { JSDOM } from "jsdom";
import type { PageTools } from "../../extension/src/content.ts";

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
const performActMock = mock.fn(async (_ref: string, _action: string, _value?: string) => {
  return {
    verdict: "dom_changed" as any,
    diff: { appeared: [], removed: [], changed: [] },
    refs: [],
  };
});

const rememberSnapshotMock = mock.fn((_refs: any[], _elements: any) => {});

const buildSnapshotMock = mock.fn((_doc: any) => {
  return {
    markdown: "Mocked Page Content",
    refs: [{ id: 1, role: "button", name: "Click Me" }],
    elements: new Map(),
    hasPasswordField: false,
  };
});

// Injected explicitly rather than through globals, so the shipped extension carries no test hooks.
const testTools = {
  buildSnapshot: buildSnapshotMock,
  rememberSnapshot: rememberSnapshotMock,
  performAct: performActMock,
} as unknown as PageTools;

// Reset the global injection guard if it was somehow set
(globalThis as any).__browsightInjected = undefined;

// 5. Import the content script
const { handleContentMessage } = await import("../../extension/src/content.ts");

test("content.ts double-injection guard", async () => {
  // Verify __browsightInjected is set to true
  assert.strictEqual((globalThis as any).__browsightInjected, true);

  // Verify only one listener is registered
  const initialListenerCount = listeners.length;
  assert.strictEqual(initialListenerCount, 1);
});

test("content.ts handles 'read' message", () => {
  const _listener = listeners[0];
  let response: any = null;
  const sendResponse = (res: any) => {
    response = res;
  };

  // Triggers listener for "read"
  const result = handleContentMessage({ kind: "read" }, sendResponse, testTools);

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
  const _listener = listeners[0];
  let response: any = null;
  const sendResponse = (res: any) => {
    response = res;
  };

  // Triggers listener for "act"
  const result = handleContentMessage(
    { kind: "act", ref: "btn-1", action: "click", value: "val-1" },
    sendResponse,
    testTools,
  );

  assert.strictEqual(result, true, "'act' message should return true");

  // Wait for the async performAct promise to resolve and invoke sendResponse
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.ok(performActMock.mock.calls.length > 0);
  assert.deepEqual(performActMock.mock.calls[0].arguments, ["btn-1", "click", "val-1"]);
  assert.strictEqual(response.verdict, "dom_changed");
});

test("content.ts accepts viewport scroll with an empty element reference", async () => {
  const _listener = listeners[0];
  let response: any = null;
  const before = performActMock.mock.calls.length;
  const result = handleContentMessage(
    { kind: "act", ref: "", action: "scroll", value: "down" },
    (res: any) => {
      response = res;
    },
    testTools,
  );

  assert.strictEqual(result, true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(performActMock.mock.calls[before].arguments, ["", "scroll", "down"]);
  assert.strictEqual(response.verdict, "dom_changed");
});

test("content.ts converts rejected page actions into a typed failure", async () => {
  const _listener = listeners[0];
  let response: any = null;
  performActMock.mock.mockImplementationOnce(async () => {
    throw new Error("frame disappeared");
  });
  const result = handleContentMessage(
    { kind: "act", ref: "btn-2", action: "click" },
    (res: any) => {
      response = res;
    },
    testTools,
  );

  assert.strictEqual(result, true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.strictEqual(response.verdict, "no_change");
  assert.strictEqual(response.sentinel.kind, "frame_unreachable");
  assert.match(response.sentinel.hint, /frame disappeared/);
});

test("content.ts ignores unknown or incomplete messages", () => {
  const _listener = listeners[0];
  let response: any = null;
  const sendResponse = (res: any) => {
    response = res;
  };

  // Unknown message kind
  // Cast deliberately: messages arrive over chrome.runtime from another context, so the handler
  // must stay safe against a kind the type system says cannot happen.
  const res1 = handleContentMessage(
    { kind: "unknown" } as unknown as Parameters<typeof handleContentMessage>[0],
    sendResponse,
    testTools,
  );
  assert.strictEqual(res1, false);
  assert.strictEqual(response, null);

  // Incomplete 'act' message (missing action/ref)
  const res2 = handleContentMessage({ kind: "act", ref: "btn-1" }, sendResponse, testTools);
  assert.strictEqual(res2, false);
  assert.strictEqual(response, null);
});
