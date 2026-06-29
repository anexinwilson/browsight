import assert from "node:assert/strict";
import { test } from "node:test";

// 1. Set up global chrome API mocks
const onInstalledCallbacks: (() => void)[] = [];
const onStartupCallbacks: (() => void)[] = [];
const onAlarmCallbacks: (() => void)[] = [];
const createdAlarms: { name: string; info: any }[] = [];

const tabsStore: Record<number, any> = {
  1: { id: 1, url: "https://google.com", title: "Google", windowId: 10 },
};
let sessionStore: Record<string, any> = {};
let localStore: Record<string, any> = {
  "browsight.grants": [
    {
      origin: "https://google.com",
      tier: "full",
      expiresAt: null,
    },
  ],
};

const chromeMock: any = {
  runtime: {
    getURL: (path: string) => `chrome-extension://mock-id/${path}`,
    getManifest: () => ({ version: "2.3.4" }),
    onInstalled: {
      addListener: (cb: () => void) => {
        onInstalledCallbacks.push(cb);
      },
    },
    onStartup: {
      addListener: (cb: () => void) => {
        onStartupCallbacks.push(cb);
      },
    },
  },
  alarms: {
    create: (name: string, info: any) => {
      createdAlarms.push({ name, info });
    },
    onAlarm: {
      addListener: (cb: () => void) => {
        onAlarmCallbacks.push(cb);
      },
    },
  },
  tabs: {
    query: async (queryInfo: any) => {
      return Object.values(tabsStore);
    },
    get: async (tabId: number) => {
      if (tabsStore[tabId]) return tabsStore[tabId];
      throw new Error("Tab not found");
    },
    update: async (tabId: number, updateProperties: any) => {
      if (tabsStore[tabId]) {
        tabsStore[tabId] = { ...tabsStore[tabId], ...updateProperties };
        return tabsStore[tabId];
      }
      throw new Error("Tab not found");
    },
    reload: async (tabId: number) => {
      return;
    },
    sendMessage: async (tabId: number, message: any) => {
      if (message.kind === "read") {
        return {
          markdown: "google search page",
          refs: [
            {
              id: 1,
              role: "button",
              name: "Search",
              recipe: { role: "button", name: "Search", dataAttrs: {}, text: "", ordinal: 0 },
            },
          ],
          hasPasswordField: false,
        };
      }
      if (message.kind === "act") {
        return {
          verdict: "dom_changed",
          diff: { appeared: [], removed: [], changed: [] },
          refs: [],
        };
      }
      return null;
    },
  },
  windows: {
    update: async (windowId: number, updateProperties: any) => {
      return {};
    },
  },
  scripting: {
    executeScript: async (info: any) => {
      return [];
    },
  },
  storage: {
    session: {
      get: async (keys: string | string[]) => {
        const result: Record<string, any> = {};
        const keyList = Array.isArray(keys) ? keys : [keys];
        for (const k of keyList) {
          result[k] = sessionStore[k];
        }
        return result;
      },
      set: async (items: Record<string, any>) => {
        sessionStore = { ...sessionStore, ...items };
      },
    },
    local: {
      get: async (keys: string | string[]) => {
        const result: Record<string, any> = {};
        const keyList = Array.isArray(keys) ? keys : [keys];
        for (const k of keyList) {
          result[k] = localStore[k];
        }
        return result;
      },
      set: async (items: Record<string, any>) => {
        localStore = { ...localStore, ...items };
      },
    },
  },
  permissions: {
    remove: async (perms: any) => true,
    request: async (perms: any) => true,
  },
};

(globalThis as any).chrome = chromeMock;

// 2. Mock global fetch API
const mockConnectionData: any = {
  port: 8137,
  token: "mock-secret-token",
  host: "127.0.0.1",
};

const fetchMock = async (url: string) => {
  if (url.endsWith("connection.json")) {
    return {
      json: async () => mockConnectionData,
    };
  }
  throw new Error(`Unexpected fetch URL: ${url}`);
};

(globalThis as any).fetch = fetchMock;

// 3. Mock global WebSocket API
const wsInstances: MockWebSocket[] = [];

class MockWebSocket {
  url: string;
  listeners: Record<string, ((...args: unknown[]) => unknown)[]> = {};
  readyState = 0; // CONNECTING
  sentMessages: string[] = [];
  closed = false;

  constructor(url: string) {
    this.url = url;
    wsInstances.push(this);
    this.readyState = 0;
  }

  addEventListener(type: string, cb: (...args: unknown[]) => unknown) {
    this.listeners[type] ??= [];
    this.listeners[type].push(cb);
  }

  send(data: string) {
    this.sentMessages.push(data);
  }

  close() {
    this.closed = true;
    this.readyState = 3; // CLOSED
    this.trigger("close", {});
  }

  trigger(type: string, eventData: any) {
    const list = this.listeners[type] || [];
    for (const cb of list) {
      cb(eventData);
    }
  }
}

(globalThis as any).WebSocket = MockWebSocket;

// Import the service worker dynamically to initialize it under mocked globals
await import("./service-worker.ts");

test("service-worker initializes and authenticates over websocket", async () => {
  assert.ok(wsInstances.length > 0, "A WebSocket should have been created");
  const ws = wsInstances[0];
  assert.strictEqual(ws.url, "ws://127.0.0.1:8137");

  // Trigger open event to verify the auth handshake payload
  ws.trigger("open", {});
  assert.strictEqual(ws.sentMessages.length, 1);
  const authPayload = JSON.parse(ws.sentMessages[0]);
  assert.deepEqual(authPayload, {
    type: "auth",
    token: "mock-secret-token",
    extensionVersion: "2.3.4",
  });
});

test("service-worker routes read requests and responds correctly", async () => {
  const ws = wsInstances[0];
  ws.sentMessages.length = 0; // reset sent messages

  // Send a mock read.request
  const readReq = {
    type: "read.request",
    id: "read-req-id",
  };

  ws.trigger("message", {
    origin: "ws://127.0.0.1:8137",
    data: JSON.stringify(readReq),
  });

  // We await a short tick for async routing/handling to finish
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.strictEqual(ws.sentMessages.length, 1);
  const response = JSON.parse(ws.sentMessages[0]);
  assert.strictEqual(response.type, "read.response");
  assert.strictEqual(response.id, "read-req-id");
  assert.strictEqual(response.markdown, "google search page");
});

test("service-worker routes act requests and responds correctly", async () => {
  const ws = wsInstances[0];
  ws.sentMessages.length = 0; // reset

  // Send a mock act.request
  const actReq = {
    type: "act.request",
    id: "act-req-id",
    action: "click",
    ref: "1",
  };

  ws.trigger("message", {
    origin: "ws://127.0.0.1:8137",
    data: JSON.stringify(actReq),
  });

  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.strictEqual(ws.sentMessages.length, 1);
  const response = JSON.parse(ws.sentMessages[0]);
  assert.strictEqual(response.type, "act.response");
  assert.strictEqual(response.id, "act-req-id");
  assert.strictEqual(response.verdict, "dom_changed");
});

test("service-worker routes tabs requests and responds correctly", async () => {
  const ws = wsInstances[0];
  ws.sentMessages.length = 0; // reset

  // Send a mock tabs.request
  const tabsReq = {
    type: "tabs.request",
    id: "tabs-req-id",
  };

  ws.trigger("message", {
    origin: "ws://127.0.0.1:8137",
    data: JSON.stringify(tabsReq),
  });

  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.strictEqual(ws.sentMessages.length, 1);
  const response = JSON.parse(ws.sentMessages[0]);
  assert.strictEqual(response.type, "tabs.response");
  assert.strictEqual(response.id, "tabs-req-id");
  assert.ok(Array.isArray(response.tabs));
  assert.strictEqual(response.tabs[0].origin, "https://google.com");
});

test("service-worker handles websocket closure, error, and alarm reconnects", async () => {
  const initialCount = wsInstances.length;
  const ws = wsInstances[wsInstances.length - 1];

  // Simulating error which leads to close
  ws.trigger("error", {});
  assert.ok(ws.closed, "Socket should be closed on error");

  // Re-firing connect via alarm
  assert.ok(onAlarmCallbacks.length > 0);
  onAlarmCallbacks[0]();

  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.strictEqual(
    wsInstances.length,
    initialCount + 1,
    "A new WebSocket instance should have been created on alarm reconnect",
  );
});
