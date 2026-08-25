#!/usr/bin/env node
/**
 * Standalone Acceptance Test: MCP Stateless Gateway Mock Client (M4)
 *
 * Programmatically verifies:
 * 1. Connecting to the Browsight server daemon via HTTP QUERY & SSE.
 * 2. Sending valid request payloads using HTTP QUERY method.
 * 3. Receiving typed response payloads.
 * 4. Immediate server-side connection termination (res.end(), Connection: close).
 * 5. Background daemon process liveness and TCP port persistence across sequential requests.
 * 6. Second sequential request under identical conditions succeeds and disconnects.
 * 7. Clean exit code 0 on pass, non-zero on failure.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { getFreePort, isPidAlive, probePort, sendHttpQuery } from "../helpers.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, "../../");
const SERVER_INDEX = join(PKG_ROOT, "server", "src", "index.ts");

async function _runAcceptanceTest() {
  console.log("================================================================================");
  console.log("  Browsight Acceptance Test: MCP Stateless Gateway Mock Client (M4)");
  console.log(`  Platform: ${process.platform} (${process.arch}) | Node: ${process.version}`);
  console.log("================================================================================");

  const testHome = join(
    tmpdir(),
    `browsight-test-request-disconnect-${Date.now()}-${randomBytes(4).toString("hex")}`,
  );
  const configDir = join(testHome, ".browsight");
  mkdirSync(configDir, { recursive: true });

  const port = await getFreePort();
  const token = `test-token-${randomBytes(16).toString("hex")}`;
  writeFileSync(join(configDir, "bridge.json"), JSON.stringify({ host: "127.0.0.1", port, token }));

  console.log(`[1/7] Initialized isolated test environment on port ${port}`);

  // Spawn server daemon
  const child = spawn(process.execPath, [SERVER_INDEX], {
    env: {
      ...process.env,
      BROWSIGHT_HOME: testHome,
      USERPROFILE: testHome,
      HOME: testHome,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const daemonPid = child.pid;
  assert.ok(daemonPid && daemonPid > 0, "Failed to obtain valid server daemon PID");
  console.log(`[2/7] Server daemon spawned with PID ${daemonPid}`);

  try {
    // Wait for daemon to become ready
    let ready = false;
    for (let i = 0; i < 50; i++) {
      if (await probePort(port)) {
        ready = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(ready, "Server daemon failed to start listening within 5s");
    console.log(`[3/7] Server daemon is active and listening on 127.0.0.1:${port}`);

    // --- CYCLE 1: First HTTP QUERY request (JSON payload) ---
    console.log("\n[4/7] Executing Request Cycle 1: HTTP QUERY (tabs.request)...");
    const req1Payload = { type: "tabs.request", id: "m4-req-1", select: null };
    const resp1 = await sendHttpQuery({ port, token, body: req1Payload });

    // No extension is attached in this test, so the honest answer is "unavailable".
    // A 200 here would mean the daemon had synthesised a tab list nobody read.
    assert.equal(resp1.statusCode, 503, "Request 1 must report the extension is unavailable");
    assert.equal(resp1.headers.connection, "close", "Request 1 must have Connection: close header");
    assert.match(String(resp1.json?.error ?? ""), /not connected/, "Request 1 must explain why");
    assert.ok(resp1.socketClosed, "Request 1 socket must be closed by server immediately");
    assert.ok(isPidAlive(daemonPid), "Daemon PID must remain alive after Request 1");
    assert.ok(await probePort(port), "Daemon port must remain listening after Request 1");
    console.log(
      `      ✔ Cycle 1 completed in ${resp1.durationMs.toFixed(2)}ms: response received, connection closed immediately, daemon persists (PID ${daemonPid})`,
    );

    // --- CYCLE 2: Second sequential HTTP QUERY request under identical conditions ---
    console.log("\n[5/7] Executing Request Cycle 2: 2nd Sequential HTTP QUERY (read.request)...");
    const req2Payload = {
      type: "read.request",
      id: "m4-req-2",
      url: null,
      mode: "full",
      schema: null,
    };
    const resp2 = await sendHttpQuery({ port, token, body: req2Payload });

    assert.equal(resp2.statusCode, 503, "Request 2 must report the extension is unavailable");
    assert.equal(resp2.headers.connection, "close", "Request 2 must have Connection: close header");
    assert.match(String(resp2.json?.error ?? ""), /not connected/, "Request 2 must explain why");
    assert.ok(resp2.socketClosed, "Request 2 socket must be closed by server immediately");
    assert.equal(child.pid, daemonPid, "Daemon PID must remain identical (no restart)");
    assert.ok(isPidAlive(daemonPid), "Daemon PID must remain alive after Request 2");
    assert.ok(await probePort(port), "Daemon port must remain listening after Request 2");
    console.log(
      `      ✔ Cycle 2 completed in ${resp2.durationMs.toFixed(2)}ms: response received, connection closed immediately, daemon persists (PID ${daemonPid})`,
    );

    // --- CYCLE 3: Third sequential request via Server-Sent Events (SSE Stream) ---
    console.log("\n[6/7] Executing Request Cycle 3: HTTP QUERY with SSE Stream (act.request)...");
    const req3Payload = { type: "act.request", id: "m4-req-3", ref: "btn1", action: "click" };
    const resp3 = await sendHttpQuery({
      port,
      token,
      body: req3Payload,
      headers: { Accept: "text/event-stream" },
    });

    assert.equal(resp3.statusCode, 503, "Request 3 must report the extension is unavailable");
    assert.equal(resp3.headers.connection, "close", "Request 3 must have Connection: close header");
    assert.match(resp3.body, /not connected/, "Request 3 must explain why");
    assert.ok(resp3.socketClosed, "Request 3 SSE stream socket must be closed by server");
    assert.ok(isPidAlive(daemonPid), "Daemon PID must remain alive after Request 3");
    assert.ok(await probePort(port), "Daemon port must remain listening after Request 3");
    console.log(
      `      ✔ Cycle 3 (SSE) completed in ${resp3.durationMs.toFixed(2)}ms: stream fulfilled & closed immediately, daemon persists (PID ${daemonPid})`,
    );

    // --- CYCLE 4: Security Token Gate ---
    console.log("\n[7/7] Executing Security Gate: Unauthorized HTTP QUERY...");
    const unauthorizedResp = await sendHttpQuery({
      port,
      token: "invalid-unauthorized-token-xyz",
      body: { type: "tabs.request", id: "unauth-test", select: null },
    });
    assert.equal(unauthorizedResp.statusCode, 401, "Unauthorized request must return 401");
    assert.equal(
      unauthorizedResp.headers.connection,
      "close",
      "Unauthorized response must close connection",
    );
    assert.ok(isPidAlive(daemonPid), "Daemon PID must remain alive after rejected request");
    console.log(
      `      ✔ Unauthorized request correctly rejected with 401 and closed immediately (${unauthorizedResp.durationMs.toFixed(2)}ms)`,
    );

    console.log(
      "\n================================================================================",
    );
    console.log("  ACCEPTANCE TEST PASSED: All Stateless Gateway Cycles Verified Successfully");
    console.log(
      "================================================================================\n",
    );
  } finally {
    // Teardown
    if (child?.pid) {
      try {
        child.kill("SIGKILL");
      } catch {}
    }
    try {
      rmSync(testHome, { recursive: true, force: true });
    } catch {}
  }
}

test("an idle daemon holds no port and exits with its parent", async () => {
  const dir = join(tmpdir(), `browsight-gateway-${Date.now()}-${randomBytes(4).toString("hex")}`);
  mkdirSync(join(dir, ".browsight"), { recursive: true });
  const port = await getFreePort();
  writeFileSync(
    join(dir, ".browsight", "bridge.json"),
    JSON.stringify({ port, token: "gateway-token" }),
  );
  const sandbox = {
    dir,
    cleanup() {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    },
  };

  const child = spawn(process.execPath, [SERVER_INDEX], {
    env: {
      ...process.env,
      BROWSIGHT_HOME: sandbox.dir,
      HOME: sandbox.dir,
      USERPROFILE: sandbox.dir,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  try {
    assert.ok(child.pid !== undefined && child.pid > 0);
    await new Promise((resolve) => setTimeout(resolve, 1200));

    // browsight only binds when a browser tool is called. Holding the port from
    // startup is what stopped a second MCP client from launching at all.
    assert.equal(await probePort(port), false, "an unused daemon must not occupy the port");
    assert.ok(isPidAlive(child.pid), "the daemon stays resident, ready to bind on demand");

    // Closing stdio is how an MCP client signals it is done; the daemon must exit.
    child.stdin?.end();
    const exited = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 4000);
      child.on("close", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    assert.ok(exited, "the daemon must exit when its client disconnects");
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {}
    sandbox.cleanup();
  }
});
