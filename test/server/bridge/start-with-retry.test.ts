import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bridge, BridgeOptions } from "../../../server/src/bridge/bridge.ts";
import { startBridgeWithRetry } from "../../../server/src/bridge/start-with-retry.ts";

const options = { port: 0, token: "t" } as BridgeOptions;

function fakeBridge(ready: Promise<void>): Bridge & { closed: () => number } {
  let closes = 0;
  return {
    ready,
    status: () => ({
      extensionConnected: false,
      detail: "",
      port: 0,
      configPort: null,
      extensionVersion: null,
      activeGrants: 0,
    }),
    reloadConfig: async () => ({ changed: false, detail: "" }),
    readActiveTab: async () => ({}) as never,
    actActiveTab: async () => ({}) as never,
    listTabs: async () => ({}) as never,
    close: async () => {
      closes++;
    },
    closed: () => closes,
  };
}

const noWait = async () => {};

test("a bridge that binds first time is returned without retrying", async () => {
  let starts = 0;
  const bridge = await startBridgeWithRetry(
    options,
    () => {
      starts++;
      return fakeBridge(Promise.resolve());
    },
    { wait: noWait },
  );
  assert.ok(bridge);
  assert.equal(starts, 1);
});

test("port contention is retried, because the other instance is usually mid-shutdown", async () => {
  let starts = 0;
  const bridge = await startBridgeWithRetry(
    options,
    () => {
      starts++;
      return fakeBridge(
        starts < 3
          ? Promise.reject(new Error("only one client can drive browsight at a time"))
          : Promise.resolve(),
      );
    },
    { wait: noWait },
  );
  assert.ok(bridge);
  assert.equal(starts, 3);
});

test("contention that never clears gives up and reports the real reason", async () => {
  let starts = 0;
  await assert.rejects(
    startBridgeWithRetry(
      options,
      () => {
        starts++;
        return fakeBridge(Promise.reject(new Error("only one client can drive browsight")));
      },
      { wait: noWait },
    ),
    /only one client/,
  );
  assert.equal(starts, 3, "the attempt limit must be honoured");
});

test("a failure that will not clear on its own is reported immediately", async () => {
  let starts = 0;
  await assert.rejects(
    startBridgeWithRetry(
      options,
      () => {
        starts++;
        return fakeBridge(Promise.reject(new Error("listen EACCES: permission denied")));
      },
      { wait: noWait },
    ),
    /EACCES/,
  );
  // Retrying a permission error only delays telling the user what is wrong.
  assert.equal(starts, 1);
});

test("every abandoned attempt releases its port", async () => {
  const created: Array<{ closed: () => number }> = [];
  await assert.rejects(
    startBridgeWithRetry(
      options,
      () => {
        const bridge = fakeBridge(Promise.reject(new Error("only one client")));
        created.push(bridge);
        return bridge;
      },
      { wait: noWait },
    ),
  );
  assert.equal(created.length, 3);
  for (const bridge of created) {
    assert.equal(bridge.closed(), 1, "a failed attempt must not leak a listener");
  }
});
