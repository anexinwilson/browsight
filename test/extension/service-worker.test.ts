import assert from "node:assert/strict";
import { test } from "node:test";

// 1. Global chrome API mocks
const onInstalledCallbacks: (() => void)[] = [];
const onStartupCallbacks: (() => void)[] = [];
const onAlarmCallbacks: ((alarm?: any) => void)[] = [];
const createdAlarms: { name: string; info: any }[] = [];
const clearedAlarms: string[] = [];
const onClickedCallbacks: ((tab?: any) => void)[] = [];
let badgeText = "";
let badgeBackgroundColor = "";

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
  action: {
    onClicked: {
      addListener: (cb: (tab?: any) => void) => {
        onClickedCallbacks.push(cb);
      },
    },
    setBadgeText: async (details: { text: string; tabId?: number }) => {
      badgeText = details.text;
    },
    setBadgeBackgroundColor: async (details: { color: string | number[]; tabId?: number }) => {
      badgeBackgroundColor = typeof details.color === "string" ? details.color : "";
    },
    getBadgeText: async () => badgeText,
  },
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
  tabs: {
    query: async (_queryInfo: any) => {
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
    reload: async (_tabId: number) => {
      return;
    },
    sendMessage: async (_tabId: number, message: any) => {
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
    update: async (_windowId: number, _updateProperties: any) => {
      return {};
    },
  },
  scripting: {
    executeScript: async (_info: any) => {
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
    remove: async (_perms: any) => true,
    request: async (_perms: any) => true,
  },
};

(globalThis as any).chrome = chromeMock;

// 2. Mock global fetch API for SSE and HTTP QUERY
const mockConnectionData: any = {
  port: 8137,
  token: "mock-secret-token",
  host: "127.0.0.1",
};

interface SentHttpCall {
  url: string;
  // Explicitly optional-or-undefined: these are recorded straight from fetch args,
  // which may pass undefined.
  options?: RequestInit | undefined;
}

const sentHttpCalls: SentHttpCall[] = [];
let _streamController: ReadableStreamDefaultController<Uint8Array> | null = null;

const fetchMock = async (url: string, options?: RequestInit) => {
  sentHttpCalls.push({ url, options });

  if (url.endsWith("connection.json")) {
    return {
      ok: true,
      status: 200,
      json: async () => mockConnectionData,
    } as any;
  }

  if (url.includes("/auth")) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ type: "auth.ok", status: "authenticated" }),
    } as any;
  }

  if (url.includes("/message")) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    } as any;
  }

  if (url.includes("/events")) {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        _streamController = controller;
      },
    });
    return {
      ok: true,
      status: 200,
      body: stream,
    } as any;
  }

  throw new Error(`Unexpected fetch URL: ${url}`);
};

(globalThis as any).fetch = fetchMock;

// Import the service worker under mocked globals
const sw = await import("../../extension/src/service-worker.ts");

function resetTestState() {
  sw.disconnect();
  sw.setSleeping(false);
  sw.setConsecutiveFailures(0);
  sentHttpCalls.length = 0;
  clearedAlarms.length = 0;
  createdAlarms.length = 0;
  badgeText = "";
  badgeBackgroundColor = "";
}

test("service-worker initializes and authenticates over HTTP QUERY & SSE", async () => {
  resetTestState();
  await sw.connect();
  await new Promise((resolve) => setTimeout(resolve, 20));

  const authCall = sentHttpCalls.find((c) => c.url.includes("/auth"));
  assert.ok(authCall, "Auth request should have been sent over HTTP QUERY");
  assert.strictEqual(authCall.options?.method, "QUERY");
  const authPayload = JSON.parse(String(authCall.options?.body));
  assert.deepEqual(authPayload, {
    type: "auth",
    token: "mock-secret-token",
    extensionVersion: "2.3.4",
  });

  const accessCall = sentHttpCalls.find((c) => {
    if (!c.url.includes("/message")) return false;
    try {
      const b = JSON.parse(String(c.options?.body));
      return b.type === "access.status";
    } catch {
      return false;
    }
  });
  assert.ok(accessCall, "Access status request should have been reported");
});

test("service-worker routes read requests and responds correctly", async () => {
  resetTestState();

  const readReq = {
    type: "read.request",
    id: "read-req-id",
    url: null,
    mode: "full",
  };

  await sw.route(JSON.stringify(readReq));
  await new Promise((resolve) => setTimeout(resolve, 20));

  const responseCall = sentHttpCalls.find((c) => c.url.includes("/message"));
  assert.ok(responseCall, "Response message must be posted");
  assert.strictEqual(responseCall.options?.method, "QUERY");
  const response = JSON.parse(String(responseCall.options?.body));
  assert.strictEqual(response.type, "read.response");
  assert.strictEqual(response.id, "read-req-id");
  assert.strictEqual(response.markdown, "google search page");
});

test("service-worker routes act requests and responds correctly", async () => {
  resetTestState();

  const actReq = {
    type: "act.request",
    id: "act-req-id",
    action: "click",
    ref: "1",
  };

  await sw.route(JSON.stringify(actReq));
  await new Promise((resolve) => setTimeout(resolve, 20));

  const responseCall = sentHttpCalls.find((c) => c.url.includes("/message"));
  assert.ok(responseCall, "Response message must be posted");
  const response = JSON.parse(String(responseCall.options?.body));
  assert.strictEqual(response.type, "act.response");
  assert.strictEqual(response.id, "act-req-id");
  assert.strictEqual(response.verdict, "dom_changed");
});

test("service-worker routes tabs requests and responds correctly", async () => {
  resetTestState();

  const tabsReq = {
    type: "tabs.request",
    id: "tabs-req-id",
    select: null,
  };

  await sw.route(JSON.stringify(tabsReq));
  await new Promise((resolve) => setTimeout(resolve, 20));

  const responseCall = sentHttpCalls.find((c) => c.url.includes("/message"));
  assert.ok(responseCall, "Response message must be posted");
  const response = JSON.parse(String(responseCall.options?.body));
  assert.strictEqual(response.type, "tabs.response");
  assert.strictEqual(response.id, "tabs-req-id");
  assert.ok(Array.isArray(response.tabs));
  assert.strictEqual(response.tabs[0].origin, "https://google.com");
});

test("service-worker handles alarm reconnects", async () => {
  resetTestState();

  assert.ok(onAlarmCallbacks.length > 0);
  onAlarmCallbacks[0]();

  await new Promise((resolve) => setTimeout(resolve, 20));

  const authCall = sentHttpCalls.find((c) => c.url.includes("/auth"));
  assert.ok(authCall, "Auth request should be triggered on alarm");
});

test("Fetch failure in loadConnection()", async () => {
  const originalFetch = (globalThis as any).fetch;
  try {
    (globalThis as any).fetch = async () => {
      throw new Error("Network error");
    };
    const res1 = await sw.loadConnection();
    assert.strictEqual(res1, null);

    (globalThis as any).fetch = async () => {
      return {
        ok: true,
        json: async () => {
          throw new Error("Invalid JSON");
        },
      };
    };
    const res2 = await sw.loadConnection();
    assert.strictEqual(res2, null);
  } finally {
    (globalThis as any).fetch = originalFetch;
  }
});

test("connect() duplicate connection serialization", async () => {
  resetTestState();
  // Concurrent connect() calls must serialize, none should increment failures or trigger sleep
  await Promise.all([sw.connect(), sw.connect(), sw.connect()]);
  assert.strictEqual(
    sw.getConsecutiveFailures(),
    0,
    "Concurrent connects must not increment failure count",
  );
  assert.strictEqual(sw.isExtensionSleeping(), false, "Concurrent connects must not trigger sleep");
});

test("connect() empty connection", async () => {
  resetTestState();
  const originalFetch = (globalThis as any).fetch;
  try {
    (globalThis as any).fetch = async () => {
      throw new Error("Fetch failed");
    };
    await sw.connect();
    assert.strictEqual(sw.getConsecutiveFailures(), 1);
  } finally {
    (globalThis as any).fetch = originalFetch;
    sw.setConsecutiveFailures(0);
  }
});

test("connect() disallowed host", async () => {
  resetTestState();
  const originalFetch = (globalThis as any).fetch;
  try {
    (globalThis as any).fetch = async (url: string) => {
      if (url.endsWith("connection.json")) {
        return {
          ok: true,
          json: async () => ({
            port: 8137,
            token: "mock-token",
            host: "example.com",
          }),
        };
      }
      throw new Error("Unexpected url");
    };
    await sw.connect();
    assert.strictEqual(sw.getConsecutiveFailures(), 1);
  } finally {
    (globalThis as any).fetch = originalFetch;
    sw.setConsecutiveFailures(0);
  }
});

test("connect() invalid port", async () => {
  resetTestState();
  const originalFetch = (globalThis as any).fetch;
  try {
    (globalThis as any).fetch = async (url: string) => {
      if (url.endsWith("connection.json")) {
        return {
          ok: true,
          json: async () => ({
            port: 99999,
            token: "mock-token",
            host: "127.0.0.1",
          }),
        };
      }
      throw new Error("Unexpected url");
    };
    await sw.connect();
    assert.strictEqual(sw.getConsecutiveFailures(), 1);
  } finally {
    (globalThis as any).fetch = originalFetch;
    sw.setConsecutiveFailures(0);
  }
});

test("route() parse error handling", async () => {
  await assert.doesNotReject(async () => {
    await sw.route("invalid-json{");
  });

  await assert.doesNotReject(async () => {
    await sw.route(JSON.stringify({ type: "unknown-type", id: "1" }));
  });
});

test("extension runtime lifecycle", async () => {
  resetTestState();

  assert.ok(onInstalledCallbacks.length > 0);
  onInstalledCallbacks[0]();
  await new Promise((resolve) => setTimeout(resolve, 20));

  sw.disconnect();
  assert.ok(onStartupCallbacks.length > 0);
  onStartupCallbacks[0]();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.ok(sentHttpCalls.length > 0);
});

test("service-worker enters sleep mode after 3 consecutive failed connection attempts", async () => {
  resetTestState();

  const originalFetch = (globalThis as any).fetch;
  (globalThis as any).fetch = async () => {
    throw new Error("connection failure");
  };

  try {
    assert.strictEqual(sw.isExtensionSleeping(), false);
    assert.strictEqual(sw.getConsecutiveFailures(), 0);

    // 1st failure
    await sw.connect();
    assert.strictEqual(sw.getConsecutiveFailures(), 1);
    assert.strictEqual(sw.isExtensionSleeping(), false);

    // 2nd failure
    await sw.connect();
    assert.strictEqual(sw.getConsecutiveFailures(), 2);
    assert.strictEqual(sw.isExtensionSleeping(), false);

    // 3rd failure -> enters sleep mode
    await sw.connect();
    assert.strictEqual(sw.getConsecutiveFailures(), 3);
    assert.strictEqual(sw.isExtensionSleeping(), true);
    assert.strictEqual(badgeText, "ZZZ");
    assert.strictEqual(badgeBackgroundColor, "#6c757d");
    // Dormant must slow the alarm down, not clear it: a cleared alarm can only be
    // revived by a toolbar click, which would strand the first tool call after the
    // server releases its port.
    assert.ok(
      !clearedAlarms.includes("browsight-keepalive"),
      "the keepalive alarm must survive so the extension can recover unattended",
    );
    const dormantAlarm = createdAlarms.filter((a) => a.name === "browsight-keepalive").at(-1);
    assert.equal(dormantAlarm?.info?.periodInMinutes, sw.DORMANT_RETRY_INTERVAL_MINUTES);
  } finally {
    (globalThis as any).fetch = originalFetch;
    sw.setSleeping(false);
    sw.setConsecutiveFailures(0);
  }
});

test("dormancy blocks ordinary reconnects but not the slow retry alarm", async () => {
  resetTestState();

  let attempts = 0;
  const originalFetch = (globalThis as any).fetch;
  (globalThis as any).fetch = async (...args: unknown[]) => {
    attempts++;
    return await originalFetch(...(args as [any, any]));
  };

  try {
    sw.setSleeping(true);
    sw.setConsecutiveFailures(3);

    // Ordinary callers stay blocked, so a burst of page events cannot hammer a port
    // the server has deliberately closed.
    await sw.connect();
    sw.requestConnection();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.strictEqual(attempts, 0, "dormant must suppress ordinary reconnect attempts");

    // The rate-limited alarm is the one channel back, so browsight can recover once
    // the server binds its port again, with no toolbar click.
    await sw.connect({ force: true });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(attempts > 0, "the dormant retry alarm must be able to reconnect unattended");
  } finally {
    (globalThis as any).fetch = originalFetch;
    sw.setSleeping(false);
    sw.setConsecutiveFailures(0);
  }
});

test("service-worker wakes up, restores alarm, clears badge, and reconnects on chrome.action.onClicked", async () => {
  resetTestState();
  sw.setSleeping(true);
  sw.setConsecutiveFailures(3);
  badgeText = "ZZZ";

  assert.ok(onClickedCallbacks.length > 0, "chrome.action.onClicked listener should be registered");
  onClickedCallbacks[0]();

  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.strictEqual(sw.isExtensionSleeping(), false, "Extension should no longer be sleeping");
  assert.strictEqual(sw.getConsecutiveFailures(), 0, "Consecutive failures should be reset to 0");
  assert.strictEqual(badgeText, "", "Badge text should be cleared");
  assert.ok(
    createdAlarms.some((a) => a.name === "browsight-keepalive" && a.info?.periodInMinutes === 0.4),
    "Keepalive alarm should be recreated",
  );
  assert.ok(sentHttpCalls.length > 0, "HTTP connection should be initiated on wakeUp");
});

test("successful HTTP QUERY & SSE authentication resets consecutive failures and clears badge", async () => {
  resetTestState();
  sw.setConsecutiveFailures(2);
  badgeText = "ZZZ";

  await sw.connect();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.strictEqual(
    sw.getConsecutiveFailures(),
    0,
    "consecutiveFailures should reset to 0 on success",
  );
  assert.strictEqual(sw.isExtensionSleeping(), false, "isSleeping should be false");
  assert.strictEqual(badgeText, "", "Badge text should be cleared");
});

test("STRESS: rapid repeated clicks on action icon during sleep mode wake cleanly with deduplicated connection", async () => {
  resetTestState();
  sw.setSleeping(true);
  sw.setConsecutiveFailures(3);
  badgeText = "ZZZ";

  assert.ok(onClickedCallbacks.length > 0, "Action onClicked callback registered");
  const burstClicks = Array.from({ length: 20 }, () => {
    return Promise.resolve().then(() => onClickedCallbacks[0]());
  });

  await Promise.all(burstClicks);
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.strictEqual(sw.isExtensionSleeping(), false, "Must exit sleep mode");
  assert.strictEqual(sw.getConsecutiveFailures(), 0, "Failures must be reset to 0");
  assert.strictEqual(badgeText, "", "Sleep badge must be cleared");
  assert.ok(
    createdAlarms.some((a) => a.name === "browsight-keepalive"),
    "Keepalive alarm must be recreated",
  );
});

test("STRESS: partial failures (2 failures -> 1 success -> counter reset) fully restore 3-failure budget", async () => {
  resetTestState();

  const originalFetch = (globalThis as any).fetch;

  try {
    // 1. First 2 attempts fail
    (globalThis as any).fetch = async () => {
      throw new Error("Temporary network glitch");
    };

    await sw.connect();
    assert.strictEqual(sw.getConsecutiveFailures(), 1);
    assert.strictEqual(sw.isExtensionSleeping(), false);

    await sw.connect();
    assert.strictEqual(sw.getConsecutiveFailures(), 2);
    assert.strictEqual(sw.isExtensionSleeping(), false);

    // 2. 3rd attempt succeeds
    (globalThis as any).fetch = fetchMock;
    await sw.connect();
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.strictEqual(
      sw.getConsecutiveFailures(),
      0,
      "Successful connection must reset consecutiveFailures to 0",
    );
    assert.strictEqual(sw.isExtensionSleeping(), false);

    // 3. Subsequent drops now get a fresh 3-failure budget
    (globalThis as any).fetch = async () => {
      throw new Error("Second outage");
    };
    sw.disconnect();

    await sw.connect();
    assert.strictEqual(sw.getConsecutiveFailures(), 1);
    assert.strictEqual(sw.isExtensionSleeping(), false);

    await sw.connect();
    assert.strictEqual(sw.getConsecutiveFailures(), 2);
    assert.strictEqual(sw.isExtensionSleeping(), false);

    await sw.connect();
    assert.strictEqual(sw.getConsecutiveFailures(), 3);
    assert.strictEqual(sw.isExtensionSleeping(), true);
    assert.strictEqual(badgeText, "ZZZ");
    assert.ok(
      !clearedAlarms.includes("browsight-keepalive"),
      "dormant slows the alarm rather than clearing it",
    );
  } finally {
    (globalThis as any).fetch = originalFetch;
    sw.setSleeping(false);
    sw.setConsecutiveFailures(0);
  }
});

test("STRESS: reconnection error handling during wake-up handles offline server gracefully", async () => {
  resetTestState();
  sw.setSleeping(true);
  sw.setConsecutiveFailures(3);
  badgeText = "ZZZ";

  const originalFetch = (globalThis as any).fetch;
  (globalThis as any).fetch = async () => {
    throw new Error("Server offline / connection refused");
  };

  try {
    onClickedCallbacks[0]();
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.strictEqual(sw.isExtensionSleeping(), false, "Should be awake (retry budget restored)");
    assert.strictEqual(
      sw.getConsecutiveFailures(),
      1,
      "Should count 1 failure for the failed wake-up connection",
    );
    assert.strictEqual(badgeText, "", "Badge cleared on wake-up");
    assert.ok(
      createdAlarms.some((a) => a.name === "browsight-keepalive"),
      "Keepalive alarm reinstated on wake-up",
    );

    // Next alarm fires -> failure 2
    onAlarmCallbacks[0]({ name: "browsight-keepalive" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.strictEqual(sw.getConsecutiveFailures(), 2);
    assert.strictEqual(sw.isExtensionSleeping(), false);

    // Next alarm fires -> failure 3 -> transitions back to sleep mode
    onAlarmCallbacks[0]({ name: "browsight-keepalive" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.strictEqual(sw.getConsecutiveFailures(), 3);
    assert.strictEqual(sw.isExtensionSleeping(), true);
    assert.strictEqual(badgeText, "ZZZ");
  } finally {
    (globalThis as any).fetch = originalFetch;
    sw.setSleeping(false);
    sw.setConsecutiveFailures(0);
  }
});

test("STRESS: burst clicks when server is offline do not exhaust retry budget prematurely", async () => {
  resetTestState();
  sw.setSleeping(true);
  sw.setConsecutiveFailures(3);
  badgeText = "ZZZ";

  const originalFetch = (globalThis as any).fetch;
  let delayResolve!: () => void;
  const inFlightPromise = new Promise<void>((resolve) => {
    delayResolve = resolve;
  });

  (globalThis as any).fetch = async () => {
    await inFlightPromise;
    throw new Error("Server down");
  };

  try {
    const clicks = Array.from({ length: 15 }, () => {
      return Promise.resolve().then(() => onClickedCallbacks[0]());
    });

    delayResolve();
    await Promise.all(clicks);
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.strictEqual(sw.isExtensionSleeping(), false);
    assert.strictEqual(
      sw.getConsecutiveFailures(),
      1,
      "Deduplicated parallel clicks should only consume 1 failure attempt",
    );
  } finally {
    (globalThis as any).fetch = originalFetch;
    sw.setSleeping(false);
    sw.setConsecutiveFailures(0);
  }
});

test("an idle server is logged quietly, a real failure is still an error", async () => {
  const sw = await import("../../extension/src/service-worker.ts");
  const originalFetch = (globalThis as any).fetch;
  const originalError = console.error;
  const originalDebug = console.debug;
  const errors: unknown[] = [];
  const debugs: unknown[] = [];
  console.error = (...args: unknown[]) => void errors.push(args[0]);
  console.debug = (...args: unknown[]) => void debugs.push(args[0]);

  try {
    // connection.json must still resolve; only the bridge call fails.
    const conn = { port: 8765, token: "t", host: "127.0.0.1" };
    const withBridgeFailure = (err: Error) => async (url: string) => {
      if (String(url).endsWith("connection.json")) {
        return { json: async () => conn } as any;
      }
      throw err;
    };

    // A server that is not bound rejects with TypeError: Failed to fetch.
    (globalThis as any).fetch = withBridgeFailure(new TypeError("Failed to fetch"));
    await sw.reportAccessStatus();
    assert.strictEqual(errors.length, 0, "an unbound server must not raise a console error");
    assert.strictEqual(debugs.length, 1, "an unbound server is logged at debug level");

    // Anything else is a genuine fault and must stay visible.
    (globalThis as any).fetch = withBridgeFailure(new Error("token rejected"));
    await sw.reportAccessStatus();
    assert.strictEqual(errors.length, 1, "a real failure must still be reported as an error");

    // A cross-realm TypeError has the right name and message but fails `instanceof`.
    const foreign = Object.assign(Object.create(null), {
      name: "TypeError",
      message: "Failed to fetch",
    });
    (globalThis as any).fetch = async (url: string) => {
      if (String(url).endsWith("connection.json")) {
        return { json: async () => conn } as any;
      }
      throw foreign;
    };
    await sw.reportAccessStatus();
    assert.strictEqual(errors.length, 1, "a cross-realm idle rejection must stay quiet");
  } finally {
    (globalThis as any).fetch = originalFetch;
    console.error = originalError;
    console.debug = originalDebug;
  }
});

test("an idle server never pushes the extension into dormant mode", async () => {
  const sw = await import("../../extension/src/service-worker.ts");
  const originalFetch = (globalThis as any).fetch;
  const conn = { port: 8765, token: "t", host: "127.0.0.1" };
  const failWith = (err: Error) => async (url: string) => {
    if (String(url).endsWith("connection.json")) {
      return { json: async () => conn } as any;
    }
    throw err;
  };

  try {
    sw.setSleeping(false);
    sw.setConsecutiveFailures(0);

    // The server is idle by design; far more attempts than MAX_CONNECTION_RETRIES must not sleep.
    (globalThis as any).fetch = failWith(new TypeError("Failed to fetch"));
    for (let i = 0; i < sw.MAX_CONNECTION_RETRIES + 3; i++) {
      await sw.reportAccessStatus();
    }
    assert.strictEqual(
      sw.getConsecutiveFailures(),
      0,
      "an idle server must not count as a failure",
    );
    assert.strictEqual(sw.isExtensionSleeping(), false, "an idle server must not trigger dormancy");
  } finally {
    (globalThis as any).fetch = originalFetch;
    sw.setSleeping(false);
    sw.setConsecutiveFailures(0);
  }
});
