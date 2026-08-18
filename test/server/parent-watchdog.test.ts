import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { isProcessAlive, startParentWatchdog } from "../../server/src/parent-watchdog.ts";

test("isProcessAlive accurately identifies running and non-existent processes", async () => {
  // Current process is alive
  assert.equal(isProcessAlive(process.pid), true);

  // Invalid PIDs return false
  assert.equal(isProcessAlive(0), false);
  assert.equal(isProcessAlive(-1), false);
  assert.equal(isProcessAlive(-999), false);
  assert.equal(isProcessAlive(Number.NaN), false);
  assert.equal(isProcessAlive(1.234), false);

  // Dead PID returns false
  const deadPid = 99999999;
  assert.equal(isProcessAlive(deadPid), false);

  // Spawned child process is alive while running and dead after exit
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"]);
  const childPid = child.pid;
  assert.ok(typeof childPid === "number" && childPid > 0);

  try {
    assert.equal(isProcessAlive(childPid), true);
    child.kill("SIGKILL");
    await new Promise((resolve) => child.on("close", resolve));
    // Wait a brief tick for OS process table update
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(isProcessAlive(childPid), false);
  } finally {
    try {
      if (childPid) {
        process.kill(childPid, "SIGKILL");
      }
    } catch {}
  }
});

test("startParentWatchdog rejects invalid parent PIDs and does not fire", async () => {
  let called = false;
  const onExit = () => {
    called = true;
  };

  const wd0 = startParentWatchdog({ parentPid: 0, intervalMs: 20, onParentExit: onExit });
  const wd1 = startParentWatchdog({ parentPid: 1, intervalMs: 20, onParentExit: onExit });
  const wdNeg = startParentWatchdog({ parentPid: -10, intervalMs: 20, onParentExit: onExit });
  const wdSelf = startParentWatchdog({
    parentPid: process.pid,
    intervalMs: 20,
    onParentExit: onExit,
  });

  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(called, false);

  wd0.stop();
  wd1.stop();
  wdNeg.stop();
  wdSelf.stop();
});

test("startParentWatchdog triggers onParentExit when monitored parent process exits", async () => {
  const mockParent = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"]);
  const parentPid = mockParent.pid;
  assert.ok(typeof parentPid === "number" && parentPid > 1);

  let exitReason: string | undefined;
  const exitPromise = new Promise<string>((resolve) => {
    startParentWatchdog({
      parentPid,
      intervalMs: 30,
      onParentExit: (reason) => {
        exitReason = reason;
        resolve(reason ?? "");
      },
    });
  });

  // Terminate the mock parent process
  mockParent.kill("SIGKILL");
  await new Promise((resolve) => mockParent.on("close", resolve));

  const reason = await Promise.race([
    exitPromise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Timeout waiting for watchdog")), 3000),
    ),
  ]);

  assert.ok(reason.includes(String(parentPid)) || reason.includes("terminated"));
  assert.ok(exitReason);
});

test("startParentWatchdog stop() deactivates watchdog and prevents callback", async () => {
  const mockParent = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"]);
  const parentPid = mockParent.pid;
  assert.ok(typeof parentPid === "number" && parentPid > 1);

  let called = false;
  const watchdog = startParentWatchdog({
    parentPid,
    intervalMs: 20,
    onParentExit: () => {
      called = true;
    },
  });

  // Stop watchdog before killing parent
  watchdog.stop();

  mockParent.kill("SIGKILL");
  await new Promise((resolve) => mockParent.on("close", resolve));
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.equal(called, false);
});
