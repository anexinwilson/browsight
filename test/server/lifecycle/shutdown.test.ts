import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { createShutdown, installShutdownTriggers } from "../../../server/src/lifecycle/shutdown.ts";

function harness(over: Partial<Parameters<typeof createShutdown>[0]> = {}) {
  const reports: string[] = [];
  const exits: number[] = [];
  return {
    reports,
    exits,
    make: (options: Partial<Parameters<typeof createShutdown>[0]> = {}) =>
      createShutdown({
        close: async () => {},
        report: (m) => reports.push(m),
        exit: (c) => exits.push(c),
        ...over,
        ...options,
      }),
  };
}

test("shutting down reports the reason, closes, and exits", async () => {
  const h = harness();
  let closed = 0;
  const shutdown = h.make({
    close: async () => {
      closed++;
    },
  });

  await shutdown("SIGTERM received");

  assert.equal(closed, 1);
  assert.deepEqual(h.exits, [0]);
  assert.match(h.reports.join(""), /SIGTERM received; shutting down/);
});

test("many triggers firing at once still shut down once", async () => {
  // stdin closing, the MCP connection closing and a signal routinely arrive together.
  const h = harness();
  let closed = 0;
  const shutdown = h.make({
    close: async () => {
      closed++;
    },
  });

  await Promise.all([shutdown("first"), shutdown("second"), shutdown("third")]);

  assert.equal(closed, 1, "close must run exactly once");
  assert.deepEqual(h.exits, [0]);
  assert.match(h.reports.join(""), /first/);
});

test("bookkeeping runs before teardown, so it happens even if teardown stalls", async () => {
  const order: string[] = [];
  const h = harness();
  const shutdown = h.make({
    before: () => order.push("before"),
    close: async () => {
      order.push("close");
    },
  });

  await shutdown("done");
  assert.deepEqual(order, ["before", "close"]);
});

test("a failure to close cleanly does not prevent exit", async () => {
  const h = harness();
  const shutdown = h.make({
    close: async () => {
      throw new Error("socket refused to close");
    },
  });

  await shutdown("closing");
  assert.deepEqual(h.exits, [0], "exiting is the point; a dirty close must not block it");
});

test("teardown that hangs is forced to exit rather than leaving the client waiting", async () => {
  const h = harness();
  const shutdown = h.make({
    close: () => new Promise<void>(() => {}), // never settles
    forceExitMs: 5,
  });

  void shutdown("hung");
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(h.exits, [0]);
});

test("stdio and signal triggers all lead to shutdown", () => {
  const reasons: string[] = [];
  const proc = Object.assign(new EventEmitter(), {
    stdin: new EventEmitter(),
    stdout: new EventEmitter(),
    platform: "linux",
  }) as unknown as NodeJS.Process;

  installShutdownTriggers(async (reason) => {
    reasons.push(reason);
  }, proc);

  proc.stdin.emit("end");
  proc.stdin.emit("error", new Error("broken"));
  proc.emit("SIGINT");
  proc.emit("SIGTERM");
  proc.emit("SIGHUP");

  assert.deepEqual(reasons, [
    "MCP stdin ended",
    "MCP stdin error",
    "SIGINT received",
    "SIGTERM received",
    "SIGHUP received",
  ]);
});

test("only a broken pipe on stdout counts as a reason to stop", () => {
  const reasons: string[] = [];
  const proc = Object.assign(new EventEmitter(), {
    stdin: new EventEmitter(),
    stdout: new EventEmitter(),
    platform: "linux",
  }) as unknown as NodeJS.Process;

  installShutdownTriggers(async (reason) => {
    reasons.push(reason);
  }, proc);

  proc.stdout.emit("error", Object.assign(new Error("nope"), { code: "EAGAIN" }));
  assert.deepEqual(reasons, [], "a transient write error is not a shutdown");

  proc.stdout.emit("error", Object.assign(new Error("gone"), { code: "EPIPE" }));
  assert.deepEqual(reasons, ["MCP stdout pipe broken (EPIPE)"]);
});
