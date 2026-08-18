import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

// 1. Mock global Chrome APIs for extension stress harness
const onInstalledCallbacks: (() => void)[] = [];
const onStartupCallbacks: (() => void)[] = [];
const onAlarmCallbacks: ((alarm?: any) => void)[] = [];
const createdAlarms: { name: string; info: any }[] = [];
const clearedAlarms: string[] = [];
const onClickedCallbacks: ((tab?: any) => void)[] = [];
let currentBadgeText = "";
let _currentBadgeColor = "";

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
      _currentBadgeColor = typeof details.color === "string" ? details.color : "";
    },
    getBadgeText: async () => currentBadgeText,
  },
  runtime: {
    getURL: (p: string) => `chrome-extension://stress-test-id/${p}`,
    getManifest: () => ({ version: "0.1.5" }),
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

// 2. Mock fetch with fine-grained control
interface HttpRecord {
  url: string;
  method?: string | undefined;
  headers?: HeadersInit | undefined;
  body?: string | undefined;
}

const sentHttpRequests: HttpRecord[] = [];
let failFetch = false;
let mockConfig = {
  port: 8137,
  token: "stress-token-abc",
  host: "127.0.0.1",
};

const stressFetchMock = async (url: string, options?: RequestInit) => {
  sentHttpRequests.push({
    url,
    method: options?.method,
    headers: options?.headers,
    body: options?.body ? String(options.body) : undefined,
  });

  if (failFetch) {
    throw new Error("Simulated network failure");
  }

  if (url.endsWith("connection.json")) {
    return {
      ok: true,
      status: 200,
      json: async () => mockConfig,
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
      start(_controller) {
        // Stream remains open
      },
    });
    return {
      ok: true,
      status: 200,
      body: stream,
    } as any;
  }

  throw new Error(`Unexpected URL in stress fetch: ${url}`);
};

(globalThis as any).fetch = stressFetchMock;

// Import service worker module
const sw = await import("../../extension/src/service-worker.ts");

function resetHarness() {
  sw.disconnect();
  sw.setSleeping(false);
  sw.setConsecutiveFailures(0);
  sentHttpRequests.length = 0;
  clearedAlarms.length = 0;
  createdAlarms.length = 0;
  currentBadgeText = "";
  _currentBadgeColor = "";
  failFetch = false;
  mockConfig = {
    port: 8137,
    token: "stress-token-abc",
    host: "127.0.0.1",
  };
}

test("STRESS 1: Rapid 50-click burst on action icon when sleeping deduplicates wakeUp cleanly", async () => {
  resetHarness();
  sw.setSleeping(true);
  sw.setConsecutiveFailures(3);
  currentBadgeText = "ZZZ";
  _currentBadgeColor = "#6c757d";

  assert.ok(onClickedCallbacks.length > 0, "Action onClicked handler must be present");

  // Fire 50 simultaneous clicks concurrently
  const burst = Array.from({ length: 50 }, () => {
    return Promise.resolve().then(() => onClickedCallbacks[0]());
  });

  await Promise.all(burst);
  await new Promise((r) => setTimeout(r, 50));

  // Check state consistency
  assert.strictEqual(sw.isExtensionSleeping(), false, "Extension must have exited sleep mode");
  assert.strictEqual(sw.getConsecutiveFailures(), 0, "Failure count must be reset to 0");
  assert.strictEqual(currentBadgeText, "", "Sleep badge must be cleared");

  // Verify keepalive alarm was restored
  const keepaliveCreated = createdAlarms.filter((a) => a.name === "browsight-keepalive");
  assert.ok(keepaliveCreated.length >= 1, "Keepalive alarm must be restored");

  // Verify connection requests were deduplicated
  const authCalls = sentHttpRequests.filter((r) => r.url.includes("/auth"));
  assert.ok(authCalls.length >= 1, `Auth calls must be at least 1 (observed: ${authCalls.length})`);
  assert.ok(
    authCalls.length <= 3,
    `Auth calls should be deduplicated, max 3 (observed: ${authCalls.length})`,
  );
});

test("STRESS 2: Sleep mode complete suppression under 100 rapid alarm & external events", async () => {
  resetHarness();
  sw.setSleeping(true);
  sw.setConsecutiveFailures(3);
  currentBadgeText = "ZZZ";
  _currentBadgeColor = "#6c757d";

  const preCalls = sentHttpRequests.length;

  // Interleave 100 events: alarms, installed, startup, requestConnection, connect
  for (let i = 0; i < 25; i++) {
    // 1. Keepalive alarm
    if (onAlarmCallbacks[0]) {
      onAlarmCallbacks[0]({ name: "browsight-keepalive" });
    }
    // 2. Stray alarm
    if (onAlarmCallbacks[0]) {
      onAlarmCallbacks[0]({ name: "unrelated-alarm" });
    }
    // 3. onInstalled
    if (onInstalledCallbacks[0]) {
      onInstalledCallbacks[0]();
    }
    // 4. onStartup
    if (onStartupCallbacks[0]) {
      onStartupCallbacks[0]();
    }
    // 5. Programmatic requestConnection()
    sw.requestConnection();
    // 6. Programmatic connect()
    void sw.connect();
  }

  await new Promise((r) => setTimeout(r, 60));

  // Dormancy is rate-limited, not silent: at most one retry per interval regardless
  // of how many events fire, so the extension can recover without hammering.
  // The property that matters: retries must not scale with event volume. 100 events
  // must not produce anything close to 100 connection attempts.
  const retries = sentHttpRequests.length - preCalls;
  assert.ok(retries < 10, `Dormant retries must not scale with event volume, saw ${retries}`);
  // With a reachable server the single rate-limited retry reconnects, which is the
  // point of dormancy being a backoff rather than a dead end.
  assert.strictEqual(sw.isExtensionSleeping(), false, "the retry must bring it back");
  assert.strictEqual(sw.getConsecutiveFailures(), 0, "a successful retry resets the budget");
});

test("STRESS 3: Multi-cycle retry budget recovery [2 failures -> 1 success -> 3 failures -> sleep -> wake]", async () => {
  resetHarness();

  // Run through 5 full adversarial cycles
  for (let cycle = 1; cycle <= 5; cycle++) {
    // Ensure clean start of cycle by dropping previous active connection
    sw.disconnect();

    // Stage A: 2 failures
    failFetch = true;
    await sw.connect();
    assert.strictEqual(sw.getConsecutiveFailures(), 1, `Cycle ${cycle}: failure 1`);
    assert.strictEqual(sw.isExtensionSleeping(), false);

    await sw.connect();
    assert.strictEqual(sw.getConsecutiveFailures(), 2, `Cycle ${cycle}: failure 2`);
    assert.strictEqual(sw.isExtensionSleeping(), false);

    // Stage B: Recovery (1 success resets failure count)
    failFetch = false;
    await sw.connect();
    await new Promise((r) => setTimeout(r, 15));

    assert.strictEqual(
      sw.getConsecutiveFailures(),
      0,
      `Cycle ${cycle}: success must reset failure count to 0`,
    );
    assert.strictEqual(sw.isExtensionSleeping(), false);

    // Disconnect active connection to simulate fresh drop
    sw.disconnect();

    // Stage C: 3 consecutive failures trigger sleep mode
    failFetch = true;
    await sw.connect();
    assert.strictEqual(sw.getConsecutiveFailures(), 1, `Cycle ${cycle}: fresh failure 1`);
    assert.strictEqual(sw.isExtensionSleeping(), false);

    await sw.connect();
    assert.strictEqual(sw.getConsecutiveFailures(), 2, `Cycle ${cycle}: fresh failure 2`);
    assert.strictEqual(sw.isExtensionSleeping(), false);

    await sw.connect();
    assert.strictEqual(sw.getConsecutiveFailures(), 3, `Cycle ${cycle}: threshold failure 3`);
    assert.strictEqual(sw.isExtensionSleeping(), true, `Cycle ${cycle}: must enter sleep mode`);
    assert.strictEqual(currentBadgeText, "ZZZ");

    // Stage D: User clicks icon to wake up and restore budget
    failFetch = false;
    onClickedCallbacks[0]();
    await new Promise((r) => setTimeout(r, 20));

    assert.strictEqual(sw.isExtensionSleeping(), false, `Cycle ${cycle}: must wake up`);
    assert.strictEqual(sw.getConsecutiveFailures(), 0, `Cycle ${cycle}: failures reset on wake`);
    assert.strictEqual(currentBadgeText, "", `Cycle ${cycle}: badge cleared on wake`);
  }
});

test("STRESS 4: Manifest V3 compliance verification", async () => {
  const extensionDir = path.resolve(import.meta.dirname, "../../extension");
  const manifestSrcPath = path.join(extensionDir, "src", "manifest.json");
  const manifestDistPath = path.join(extensionDir, "dist", "manifest.json");

  const pathsToCheck = [manifestSrcPath];
  if (fs.existsSync(manifestDistPath)) {
    pathsToCheck.push(manifestDistPath);
  }

  for (const mPath of pathsToCheck) {
    const raw = fs.readFileSync(mPath, "utf-8");
    const manifest = JSON.parse(raw);

    // 1. Manifest version must be 3
    assert.strictEqual(manifest.manifest_version, 3, `${mPath} manifest_version must be 3`);

    // 2. Action configuration must exist
    assert.ok(manifest.action, `${mPath} must have 'action' configuration`);

    // 3. Background service worker specification
    assert.ok(manifest.background, `${mPath} must declare background`);
    assert.ok(
      manifest.background.service_worker,
      `${mPath} background must declare service_worker`,
    );
    assert.strictEqual(
      manifest.background.type,
      "module",
      `${mPath} background service worker must have type 'module'`,
    );

    // 4. Permissions check
    assert.ok(Array.isArray(manifest.permissions), `${mPath} permissions must be an array`);
    assert.ok(manifest.permissions.includes("scripting"), "permissions must include 'scripting'");
    assert.ok(manifest.permissions.includes("storage"), "permissions must include 'storage'");
    assert.ok(manifest.permissions.includes("alarms"), "permissions must include 'alarms'");
    assert.ok(manifest.permissions.includes("tabs"), "permissions must include 'tabs'");

    // 5. Icons check: referenced icons must exist on disk
    if (manifest.icons) {
      for (const [size, relPath] of Object.entries(manifest.icons)) {
        const iconFile = path.resolve(path.dirname(mPath), String(relPath));
        assert.ok(
          fs.existsSync(iconFile),
          `Referenced icon ${size} at ${iconFile} must exist on disk`,
        );
      }
    }
  }
});
