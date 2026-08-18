#!/usr/bin/env node
/**
 * Standalone Acceptance Test: Server Orphan Process Auto-Termination
 *
 * Verifies that when a parent process (MCP client or shell) is forcefully killed,
 * the spawned Browsight server process automatically detects parent death and
 * terminates within the 3.0-second (3000ms) SLA. Also verifies port deallocation.
 *
 * Exit Code: 0 on PASS, 1 on FAIL
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { getFreePort, isPidAlive as isProcessAlive, sleep } from "../helpers.ts";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "../../");
const SERVER_ENTRY = join(PROJECT_ROOT, "server", "src", "index.ts");
const SLA_LIMIT_MS = 3000.0;
const POLL_INTERVAL_MS = 15;

function createSandbox() {
  const testId = `browsight-orphan-${Date.now()}-${randomBytes(4).toString("hex")}`;
  const dir = join(tmpdir(), testId);
  const configDir = join(dir, ".browsight");
  mkdirSync(configDir, { recursive: true });
  return {
    dir,
    configDir,
    writeConfig(port = 0, token = "test-orphan-token") {
      writeFileSync(join(configDir, "bridge.json"), JSON.stringify({ port, token }));
    },
    cleanup() {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    },
  };
}

async function runScenario1_AbruptParentKill() {
  console.log("\n[SCENARIO 1] Abrupt Parent Hard Kill (SIGKILL / TerminateProcess)");
  const sandbox = createSandbox();
  sandbox.writeConfig(0);

  let parentProcess: ReturnType<typeof spawn> | null = null;
  let childPid: number | undefined;
  let parentPid: number | undefined;

  try {
    const parentCode = `
      import { spawn } from "node:child_process";
      const child = spawn(process.execPath, [${JSON.stringify(SERVER_ENTRY)}], {
        env: {
          ...process.env,
          BROWSIGHT_HOME: ${JSON.stringify(sandbox.dir)},
          HOME: ${JSON.stringify(sandbox.dir)},
          USERPROFILE: ${JSON.stringify(sandbox.dir)},
        },
        stdio: ["pipe", "pipe", "inherit"],
      });
      
      console.log(JSON.stringify({
        type: "ready",
        parentPid: process.pid,
        childPid: child.pid,
      }));

      // Keep parent alive
      setInterval(() => {}, 60000);
    `;

    parentProcess = spawn(process.execPath, ["--input-type=module", "-e", parentCode], {
      stdio: ["pipe", "pipe", "inherit"],
    });

    const initData = await new Promise<{ parentPid: number; childPid: number }>(
      (resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Timeout waiting for simulated parent handshake")),
          8000,
        );
        let buffer = "";
        parentProcess?.stdout?.on("data", (chunk: Buffer) => {
          buffer += chunk.toString();
          const lines = buffer.split("\n");
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const parsed = JSON.parse(line.trim());
              if (parsed.type === "ready") {
                clearTimeout(timer);
                resolve(parsed);
                return;
              }
            } catch {}
          }
        });
      },
    );

    parentPid = initData.parentPid;
    childPid = initData.childPid;
    assert.ok(parentPid > 1, `Invalid parent PID: ${parentPid}`);
    assert.ok(childPid > 1, `Invalid child server PID: ${childPid}`);

    // Allow server time to boot and initialize parent watchdog
    await sleep(400);
    assert.equal(isProcessAlive(childPid), true, `Child server PID ${childPid} should be alive`);

    console.log(`  -> Spawned Parent PID: ${parentPid}, Server Child PID: ${childPid}`);
    console.log(`  -> Executing hard kill on Parent PID: ${parentPid}...`);

    const t0 = performance.now();
    try {
      process.kill(parentPid, "SIGKILL");
    } catch {}

    // Verify parent process is dead
    let parentTerminated = false;
    for (let i = 0; i < 50; i++) {
      if (!isProcessAlive(parentPid)) {
        parentTerminated = true;
        break;
      }
      await sleep(10);
    }
    assert.ok(parentTerminated, `Simulated parent PID ${parentPid} must be terminated`);

    // Poll child PID until termination or timeout
    let childDead = false;
    let elapsedMs = 0;

    while (true) {
      elapsedMs = performance.now() - t0;
      if (!isProcessAlive(childPid)) {
        childDead = true;
        break;
      }
      if (elapsedMs > SLA_LIMIT_MS + 2000) {
        break;
      }
      await sleep(POLL_INTERVAL_MS);
    }

    console.log(`  -> Server Child PID ${childPid} exited in ${elapsedMs.toFixed(2)}ms`);
    assert.ok(childDead, `Child server PID ${childPid} did NOT terminate after parent death`);
    assert.ok(
      elapsedMs <= SLA_LIMIT_MS,
      `SLA VIOLATION: Server terminated in ${elapsedMs.toFixed(2)}ms (Limit: <= ${SLA_LIMIT_MS}ms)`,
    );
    console.log(`  ✔ PASS: Terminated in ${elapsedMs.toFixed(2)}ms (SLA <= 3000ms)`);
  } finally {
    if (parentPid) {
      try {
        process.kill(parentPid, "SIGKILL");
      } catch {}
    }
    if (childPid) {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {}
    }
    sandbox.cleanup();
  }
}

async function runScenario2_StdioDisconnect() {
  console.log("\n[SCENARIO 2] Parent Stdio Stream Closure (stdin EOF)");
  const sandbox = createSandbox();
  sandbox.writeConfig(0);

  let child: ReturnType<typeof spawn> | null = null;
  try {
    child = spawn(process.execPath, [SERVER_ENTRY], {
      env: {
        ...process.env,
        BROWSIGHT_HOME: sandbox.dir,
        HOME: sandbox.dir,
        USERPROFILE: sandbox.dir,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const childPid = child.pid;
    assert.ok(childPid !== undefined && childPid > 1);
    await sleep(400);
    assert.equal(isProcessAlive(childPid), true);

    console.log(`  -> Server running (PID: ${childPid}). Closing stdin...`);
    const t0 = performance.now();
    child.stdin?.end();

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Timeout waiting for child exit after stdin end")),
        4000,
      );
      child?.on("close", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });

    const elapsed = performance.now() - t0;
    console.log(`  -> Server closed with code ${exitCode} in ${elapsed.toFixed(2)}ms`);
    assert.equal(exitCode, 0, "Server must exit cleanly with code 0 on stdin EOF");
    assert.ok(
      elapsed <= 2500,
      `Server took ${elapsed.toFixed(2)}ms to exit on stdin EOF (expected <= 2500ms)`,
    );
    console.log(`  ✔ PASS: Stdio teardown completed in ${elapsed.toFixed(2)}ms`);
  } finally {
    if (child?.pid) {
      try {
        child.kill("SIGKILL");
      } catch {}
    }
    sandbox.cleanup();
  }
}

async function runScenario3_PortDeallocation() {
  console.log("\n[SCENARIO 3] Port Deallocation & EADDRINUSE Prevention");
  const testPort = await getFreePort();

  const sandbox = createSandbox();
  sandbox.writeConfig(testPort);

  let parentProcess: ReturnType<typeof spawn> | null = null;
  let childPid: number | undefined;
  let parentPid: number | undefined;

  try {
    const parentCode = `
      import { spawn } from "node:child_process";
      const child = spawn(process.execPath, [${JSON.stringify(SERVER_ENTRY)}], {
        env: {
          ...process.env,
          BROWSIGHT_HOME: ${JSON.stringify(sandbox.dir)},
          HOME: ${JSON.stringify(sandbox.dir)},
          USERPROFILE: ${JSON.stringify(sandbox.dir)},
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      console.log(JSON.stringify({ type: "ready", parentPid: process.pid, childPid: child.pid }));
      setInterval(() => {}, 60000);
    `;

    parentProcess = spawn(process.execPath, ["--input-type=module", "-e", parentCode], {
      stdio: ["pipe", "pipe", "inherit"],
    });

    const initData = await new Promise<{ parentPid: number; childPid: number }>(
      (resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Timeout waiting for parent handshake")),
          8000,
        );
        let buffer = "";
        parentProcess?.stdout?.on("data", (chunk: Buffer) => {
          buffer += chunk.toString();
          const lines = buffer.split("\n");
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const parsed = JSON.parse(line.trim());
              if (parsed.type === "ready") {
                clearTimeout(timer);
                resolve(parsed);
                return;
              }
            } catch {}
          }
        });
      },
    );

    parentPid = initData.parentPid;
    childPid = initData.childPid;

    await sleep(400);
    assert.equal(isProcessAlive(childPid), true);

    console.log(`  -> Server bound to port ${testPort} (PID: ${childPid})`);
    console.log(`  -> Killing parent PID: ${parentPid}...`);
    try {
      process.kill(parentPid, "SIGKILL");
    } catch {}

    // Wait for child to terminate
    const t0 = performance.now();
    while (isProcessAlive(childPid)) {
      if (performance.now() - t0 > 3000) break;
      await sleep(15);
    }
    assert.equal(isProcessAlive(childPid), false, "Server child must be terminated");

    // Verify port is immediately available for binding without EADDRINUSE
    const canBind = await new Promise((resolve) => {
      const tester = http.createServer();
      tester.once("error", () => resolve(false));
      tester.listen(testPort, "127.0.0.1", () => {
        tester.close(() => resolve(true));
      });
    });

    assert.equal(canBind, true, `Port ${testPort} must be immediately bindable after orphan exit`);
    console.log(`  ✔ PASS: Port ${testPort} successfully reclaimed without EADDRINUSE`);
  } finally {
    if (parentPid) {
      try {
        process.kill(parentPid, "SIGKILL");
      } catch {}
    }
    if (childPid) {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {}
    }
    sandbox.cleanup();
  }
}

test("Orphan Process Termination Acceptance Test Suite", async () => {
  await runScenario1_AbruptParentKill();
  await runScenario2_StdioDisconnect();
  await runScenario3_PortDeallocation();
});
