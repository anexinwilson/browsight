/**
 * The lazy bridge is what lets two MCP clients coexist: neither holds the loopback
 * port until someone actually calls a browser tool.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bridge } from "../../../server/src/bridge/bridge.ts";
import { createLazyBridge } from "../../../server/src/bridge/lazy-bridge.ts";

function fakeBridge(onClose?: () => void): Bridge {
  return {
    ready: Promise.resolve(),
    status: () => ({
      extensionConnected: true,
      detail: "extension connected",
      port: 8137,
      configPort: 8137,
      extensionVersion: "0.1.5",
      activeGrants: 2,
    }),
    reloadConfig: async () => ({ changed: false, detail: "unchanged" }),
    readActiveTab: async () => ({
      type: "read.response" as const,
      id: "r",
      markdown: "page",
      refs: [],
      hasPasswordField: false,
      truncated: false,
      nextOffset: 0,
    }),
    actActiveTab: async () => ({
      type: "act.response" as const,
      id: "a",
      verdict: "dom_changed" as const,
      diff: { appeared: [], removed: [], changed: [] },
      refs: [],
    }),
    listTabs: async () => ({
      type: "tabs.response" as const,
      id: "t",
      tabs: [],
      refs: [],
      hasPasswordField: false,
    }),
    close: async () => {
      onClose?.();
    },
  };
}

const options = { port: 8137, token: "t" };

test("binds nothing until a browser tool is called", async () => {
  let starts = 0;
  const bridge = createLazyBridge({
    options,
    start: async () => {
      starts++;
      return fakeBridge();
    },
  });

  await bridge.ready;
  assert.equal(starts, 0, "constructing the bridge must not open a port");
  assert.equal(bridge.isBound(), false);

  await bridge.listTabs(null);
  assert.equal(starts, 1, "the first tool call binds");
  assert.equal(bridge.isBound(), true);
});

test("reports status without binding, so asking is not what connects", async () => {
  let starts = 0;
  const bridge = createLazyBridge({
    options,
    start: async () => {
      starts++;
      return fakeBridge();
    },
  });

  const idle = bridge.status();
  assert.equal(starts, 0, "status must never open a port");
  assert.equal(idle.extensionConnected, false);
  assert.equal(idle.port, 0);
  assert.equal(idle.configPort, 8137);
  assert.match(idle.detail, /idle and holding no port/);

  await bridge.listTabs(null);
  const live = bridge.status();
  assert.equal(live.extensionConnected, true);
  assert.equal(live.port, 8137);
});

test("concurrent first calls share one bind instead of racing for the port", async () => {
  let starts = 0;
  const bridge = createLazyBridge({
    options,
    start: async () => {
      starts++;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return fakeBridge();
    },
  });

  await Promise.all([bridge.listTabs(null), bridge.listTabs(null), bridge.readActiveTab(null)]);
  assert.equal(starts, 1, "three simultaneous calls must produce one listener");
});

test("release frees the port and the next call re-binds", async () => {
  let starts = 0;
  let closes = 0;
  const bridge = createLazyBridge({
    options,
    start: async () => {
      starts++;
      return fakeBridge(() => closes++);
    },
  });

  await bridge.listTabs(null);
  assert.equal(bridge.isBound(), true);

  await bridge.release("idle");
  assert.equal(closes, 1);
  assert.equal(bridge.isBound(), false, "the port must be free for another client");

  await bridge.listTabs(null);
  assert.equal(starts, 2, "a later call re-binds on demand");
});

test("a failed bind does not poison later attempts", async () => {
  let attempt = 0;
  const bridge = createLazyBridge({
    options,
    start: async () => {
      attempt++;
      if (attempt === 1) throw new Error("EADDRINUSE");
      return fakeBridge();
    },
  });

  await assert.rejects(() => bridge.listTabs(null), /EADDRINUSE/);
  assert.equal(bridge.isBound(), false);

  // The other client may have released the port since; retrying must be possible.
  const res = await bridge.listTabs(null);
  assert.equal(res.type, "tabs.response");
  assert.equal(attempt, 2);
});

test("release is safe when nothing was ever bound", async () => {
  const bridge = createLazyBridge({
    options,
    start: async () => fakeBridge(),
  });
  await bridge.release("never used");
  assert.equal(bridge.isBound(), false);
});

test("a bind that finishes after a release does not resurrect the bridge", async () => {
  // Regression: `release` cleared `current` but not the start in flight, so the bind completed
  // afterwards and installed itself, re-binding the port on a bridge nobody was holding. On
  // shutdown that left a listener behind on a process that was exiting.
  let releaseStart!: (bridge: Bridge) => void;
  let closes = 0;
  let binds = 0;

  const lazy = createLazyBridge({
    options: { port: 0, token: "t" },
    onBind: () => {
      binds++;
    },
    start: () =>
      new Promise<Bridge>((resolve) => {
        releaseStart = resolve;
      }),
  });

  const inFlight = lazy.readActiveTab(null).catch((err: unknown) => err);
  await lazy.release("idle");

  releaseStart(
    fakeBridge(() => {
      closes++;
    }),
  );

  const outcome = await inFlight;
  assert.ok(outcome instanceof Error);
  assert.match(outcome.message, /released the port while it was connecting/);
  assert.equal(lazy.isBound(), false, "the abandoned bind must not become the live bridge");
  assert.equal(closes, 1, "the abandoned bridge must release its port");
  assert.equal(binds, 0);
});
