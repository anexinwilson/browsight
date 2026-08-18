import assert from "node:assert/strict";
import { test } from "node:test";

// Mock environment setup
const onInstalledCallbacks: (() => void)[] = [];
const onStartupCallbacks: (() => void)[] = [];
const onAlarmCallbacks: ((alarm?: any) => void)[] = [];
const createdAlarms: { name: string; info: any }[] = [];
const clearedAlarms: string[] = [];
const onClickedCallbacks: ((tab?: any) => void)[] = [];
let currentBadgeText = "";
let currentBadgeColor = "";

const mockChrome: any = {
  action: {
    onClicked: {
      addListener: (cb: (tab?: any) => void) => {
        onClickedCallbacks.push(cb);
      },
    },
    setBadgeText: async (details: { text: string; tabId?: number }) => {
      currentBadgeText = details.text;
    },
    setBadgeBackgroundColor: async (details: { color: string | number[]; tabId?: number }) => {
      currentBadgeColor = typeof details.color === "string" ? details.color : "";
    },
    getBadgeText: async () => currentBadgeText,
  },
  runtime: {
    getURL: (path: string) => `chrome-extension://adversarial-mock-id/${path}`,
    getManifest: () => ({ version: "1.0.0-test" }),
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
    clear: async (name: string) => {
      clearedAlarms.push(name);
      return true;
    },
    onAlarm: {
      addListener: (cb: (alarm?: any) => void) => {
        onAlarmCallbacks.push(cb);
      },
    },
  },
  storage: {
    session: {
      get: async () => ({}),
      set: async () => {},
    },
    local: {
      get: async () => ({ "browsight.grants": [] }),
      set: async () => {},
    },
  },
  permissions: {
    remove: async () => true,
    request: async () => true,
  },
  tabs: {
    query: async () => [],
    get: async () => ({}),
    sendMessage: async () => null,
  },
};

(globalThis as any).chrome = mockChrome;

let mockFetchConfig: any = {
  port: 8137,
  token: "adversarial-token-123",
  host: "127.0.0.1",
};
let fetchShouldFail = false;
let fetchAttempts = 0;
const fetchFailError = new Error("Connection file unreachable");

const mockFetch = async (url: string, _init?: any) => {
  if (url.endsWith("/auth")) fetchAttempts++;
  if (fetchShouldFail) {
    throw fetchFailError;
  }
  if (url.endsWith("connection.json")) {
    return {
      json: async () => mockFetchConfig,
    };
  }
  if (url.endsWith("/auth")) {
    return { ok: true, status: 200, json: async () => ({}) };
  }
  if (url.endsWith("/events")) {
    return {
      ok: true,
      body: {
        getReader: () => ({
          read: () => new Promise(() => {}), // never resolves, simulating open stream
        }),
      },
    };
  }
  throw new Error(`Unexpected fetch URL: ${url}`);
};

(globalThis as any).fetch = mockFetch;

const mockWsInstances: MockWebSocketAdv[] = [];

class MockWebSocketAdv {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  url: string;
  listeners: Record<string, ((...args: unknown[]) => unknown)[]> = {};
  readyState = 0;
  sentMessages: string[] = [];
  closed = false;
  onmessage: ((event: any) => unknown) | null = null;

  constructor(url: string) {
    this.url = url;
    mockWsInstances.push(this);
    this.readyState = 0;
  }

  addEventListener(type: string, cb: (...args: unknown[]) => unknown) {
    this.listeners[type] ??= [];
    this.listeners[type].push(cb);
  }

  send(data: string) {
    this.sentMessages.push(data);
  }

  close(code?: number) {
    this.closed = true;
    this.readyState = 3;
    this.trigger("close", { code });
  }

  trigger(type: string, eventData: any) {
    if (type === "open") {
      this.readyState = MockWebSocketAdv.OPEN;
    }
    if (type === "message") {
      this.onmessage?.(eventData);
    }
    const list = this.listeners[type] || [];
    for (const cb of list) {
      cb(eventData);
    }
  }
}

(globalThis as any).WebSocket = MockWebSocketAdv;

// Import the service worker under test
const sw = await import("../../extension/src/service-worker.ts");

function resetTestState() {
  sw.disconnect();
  sw.setSleeping(false);
  sw.setConsecutiveFailures(0);
  currentBadgeText = "";
  currentBadgeColor = "";
  clearedAlarms.length = 0;
  createdAlarms.length = 0;
  fetchAttempts = 0;
  fetchShouldFail = false;
  mockFetchConfig = {
    port: 8137,
    token: "adversarial-token-123",
    host: "127.0.0.1",
  };
}

test("ADVERSARIAL: Exact 3-failure threshold transitions to sleep mode", async () => {
  resetTestState();
  fetchShouldFail = true;

  // Failure 1:
  await sw.connect();
  assert.strictEqual(sw.getConsecutiveFailures(), 1, "Should be 1 failure");
  assert.strictEqual(sw.isExtensionSleeping(), false, "Should NOT sleep after 1 failure");
  assert.strictEqual(currentBadgeText, "", "Badge should remain empty after 1 failure");
  assert.strictEqual(clearedAlarms.length, 0, "Alarm should not be cleared after 1 failure");

  // Failure 2:
  await sw.connect();
  assert.strictEqual(sw.getConsecutiveFailures(), 2, "Should be 2 failures");
  assert.strictEqual(sw.isExtensionSleeping(), false, "Should NOT sleep after 2 failures");
  assert.strictEqual(currentBadgeText, "", "Badge should remain empty after 2 failures");
  assert.strictEqual(clearedAlarms.length, 0, "Alarm should not be cleared after 2 failures");

  // Failure 3 (Threshold hit):
  await sw.connect();
  assert.strictEqual(sw.getConsecutiveFailures(), 3, "Should be 3 failures");
  assert.strictEqual(sw.isExtensionSleeping(), true, "Should enter sleep mode after 3 failures");
  assert.strictEqual(currentBadgeText, "ZZZ", "Badge text must be 'ZZZ'");
  assert.strictEqual(currentBadgeColor, "#6c757d", "Badge color must be '#6c757d'");
  assert.ok(
    !clearedAlarms.includes("browsight-keepalive"),
    "Alarm must survive dormancy so the extension can reconnect once the port is bound",
  );
  assert.equal(
    createdAlarms.filter((a) => a.name === "browsight-keepalive").at(-1)?.info?.periodInMinutes,
    sw.DORMANT_RETRY_INTERVAL_MINUTES,
    "Dormant retries must slow down rather than stop",
  );

  // Attempted failure 4 while sleeping should not break state or increment count:
  await sw.connect();
  assert.strictEqual(sw.isExtensionSleeping(), true, "Should stay sleeping");
  assert.strictEqual(
    sw.getConsecutiveFailures(),
    3,
    "Failure count should remain capped / guarded",
  );
});

test("ADVERSARIAL: Intermittent connection success resets failure count", async () => {
  resetTestState();

  // 2 initial failures
  fetchShouldFail = true;
  await sw.connect();
  await sw.connect();
  assert.strictEqual(sw.getConsecutiveFailures(), 2);
  assert.strictEqual(sw.isExtensionSleeping(), false);

  // Recovery: fetch succeeds, websocket opens and authenticates
  fetchShouldFail = false;
  void sw.connect();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.strictEqual(fetchAttempts, 1);

  assert.strictEqual(
    sw.getConsecutiveFailures(),
    0,
    "Failures must reset to 0 upon successful auth",
  );
  assert.strictEqual(sw.isExtensionSleeping(), false);
  assert.strictEqual(currentBadgeText, "");

  // Now 2 more failures occur, should NOT trigger sleep because count reset
  // First abort the active connection to simulate disconnection
  sw.disconnect();
  fetchShouldFail = true;
  await sw.connect();
  await sw.connect();
  assert.strictEqual(sw.getConsecutiveFailures(), 2);
  assert.strictEqual(
    sw.isExtensionSleeping(),
    false,
    "Must not sleep after only 2 failures after reset",
  );

  // 3rd failure triggers sleep
  await sw.connect();
  assert.strictEqual(sw.getConsecutiveFailures(), 3);
  assert.strictEqual(sw.isExtensionSleeping(), true);
  assert.strictEqual(currentBadgeText, "ZZZ");
});

test("ADVERSARIAL: Complete suppression of alarms, requests, and startups during sleep", async () => {
  resetTestState();
  sw.setSleeping(true);
  sw.setConsecutiveFailures(3);

  const initialSocketCount = fetchAttempts;

  // 1. Alarm firing browsight-keepalive
  assert.ok(onAlarmCallbacks.length > 0);
  onAlarmCallbacks[0]({ name: "browsight-keepalive" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  // Dormancy is rate-limited rather than silent, so the extension can recover once
  // the server binds its port again.
  const afterKeepalive = fetchAttempts;
  assert.ok(
    afterKeepalive - initialSocketCount <= 1,
    "the dormant keepalive alarm makes at most one rate-limited retry",
  );

  // 2. Alarm firing with unknown name
  onAlarmCallbacks[0]({ name: "other-alarm" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.strictEqual(fetchAttempts, afterKeepalive, "an unrelated alarm must be ignored");

  // 3. Direct requestConnection() call
  sw.requestConnection();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.strictEqual(
    fetchAttempts,
    afterKeepalive,
    "requestConnection must be suppressed when sleeping",
  );

  // 4. Direct connect() call
  await sw.connect();
  assert.strictEqual(fetchAttempts, afterKeepalive, "connect must return early when sleeping");

  // 5. onInstalled event
  assert.ok(onInstalledCallbacks.length > 0);
  onInstalledCallbacks[0]();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.strictEqual(
    fetchAttempts,
    afterKeepalive,
    "onInstalled must not trigger connection when sleeping",
  );

  // 6. onStartup event
  assert.ok(onStartupCallbacks.length > 0);
  onStartupCallbacks[0]();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.strictEqual(
    fetchAttempts,
    afterKeepalive,
    "onStartup must not trigger connection when sleeping",
  );
});

test("ADVERSARIAL: Wake-up sequence on chrome.action.onClicked restores system completely", async () => {
  resetTestState();
  sw.setSleeping(true);
  sw.setConsecutiveFailures(3);
  currentBadgeText = "ZZZ";
  currentBadgeColor = "#6c757d";
  clearedAlarms.length = 0;
  createdAlarms.length = 0;

  assert.ok(onClickedCallbacks.length > 0, "Action onClicked listener must be registered");
  onClickedCallbacks[0]();

  await new Promise((resolve) => setTimeout(resolve, 20));

  // Verify state restoration
  assert.strictEqual(sw.isExtensionSleeping(), false, "Extension must not be sleeping after click");
  assert.strictEqual(sw.getConsecutiveFailures(), 0, "Consecutive failures must be 0");
  assert.strictEqual(currentBadgeText, "", "Badge text must be cleared");

  // Verify alarm recreated
  const keepaliveCreated = createdAlarms.find(
    (a) => a.name === "browsight-keepalive" && a.info?.periodInMinutes === 0.4,
  );
  assert.ok(keepaliveCreated, "Keepalive alarm must be recreated with 0.4 period");

  // Verify WebSocket connection was initiated
  assert.strictEqual(fetchAttempts, 1, "New WebSocket must be dialed");
});

test("ADVERSARIAL: Re-entering sleep after wake-up if server is permanently down", async () => {
  resetTestState();
  sw.setSleeping(true);
  sw.setConsecutiveFailures(3);
  currentBadgeText = "ZZZ";
  fetchShouldFail = true;

  // Click to wake
  onClickedCallbacks[0]();
  await new Promise((resolve) => setTimeout(resolve, 20));

  // The wake-up call attempted connection which failed (failure 1)
  assert.strictEqual(sw.isExtensionSleeping(), false);
  assert.strictEqual(sw.getConsecutiveFailures(), 1);

  // Failure 2
  await sw.connect();
  assert.strictEqual(sw.getConsecutiveFailures(), 2);
  assert.strictEqual(sw.isExtensionSleeping(), false);

  // Failure 3
  await sw.connect();
  assert.strictEqual(sw.getConsecutiveFailures(), 3);
  assert.strictEqual(
    sw.isExtensionSleeping(),
    true,
    "Must re-enter sleep mode on 3 consecutive failures",
  );
  assert.strictEqual(currentBadgeText, "ZZZ");
});

test("ADVERSARIAL: Rapid concurrent clicks during sleep serialize without multiple sockets", async () => {
  resetTestState();
  sw.setSleeping(true);
  sw.setConsecutiveFailures(3);

  // Trigger 10 concurrent clicks
  for (let i = 0; i < 10; i++) {
    onClickedCallbacks[0]();
  }

  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.strictEqual(sw.isExtensionSleeping(), false);
  assert.strictEqual(sw.getConsecutiveFailures(), 0);
  assert.strictEqual(fetchAttempts, 1, "Must serialize to exactly 1 connection attempt");
});

test("ADVERSARIAL: Multiple failure vectors each accurately increment failures towards sleep", async () => {
  // Vector 1: Disallowed host
  resetTestState();
  mockFetchConfig = { port: 8137, token: "token", host: "192.168.1.100" };
  await sw.connect();
  assert.strictEqual(sw.getConsecutiveFailures(), 1);

  // Vector 2: Invalid port (out of range)
  mockFetchConfig = { port: 99999, token: "token", host: "127.0.0.1" };
  await sw.connect();
  assert.strictEqual(sw.getConsecutiveFailures(), 2);

  // Vector 3: Network failure before auth
  mockFetchConfig = { port: 8137, token: "token", host: "127.0.0.1" };
  fetchShouldFail = true;
  await sw.connect();

  assert.strictEqual(sw.getConsecutiveFailures(), 3);
  assert.strictEqual(sw.isExtensionSleeping(), true);
  assert.strictEqual(currentBadgeText, "ZZZ");
});
