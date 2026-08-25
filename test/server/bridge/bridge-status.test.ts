/** Covers browser_status's data source: connection reporting and config reload. */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startBridge } from "../../../server/src/bridge/bridge.ts";

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

function tempConfig(port: number, token: string): string {
  const dir = mkdtempSync(join(tmpdir(), "browsight-status-"));
  const path = join(dir, "bridge.json");
  writeFileSync(path, JSON.stringify({ port, token }));
  return path;
}

test("status reports a disconnected extension without throwing", async () => {
  const port = await getFreePort();
  const configPath = tempConfig(port, "t");
  const bridge = startBridge({ port, token: "t", configPath, extensionWaitMs: 10 });
  await bridge.ready;
  try {
    const s = bridge.status();
    assert.equal(s.extensionConnected, false);
    assert.equal(s.port, port);
    assert.equal(s.configPort, port);
    assert.equal(s.extensionVersion, null);
    assert.equal(s.activeGrants, 0);
    assert.match(s.detail, /reload the browsight extension/);
  } finally {
    await bridge.close();
  }
});

test("status detail matches the error the tools throw", async () => {
  const port = await getFreePort();
  const configPath = tempConfig(port + 1, "rotated");
  const bridge = startBridge({ port, token: "t", configPath, extensionWaitMs: 10 });
  await bridge.ready;
  try {
    const s = bridge.status();
    // One source of truth: whatever status says is what the tool call reports.
    await assert.rejects(
      () => bridge.listTabs(null),
      (err: Error) => {
        assert.equal(err.message, s.detail);
        return true;
      },
    );
  } finally {
    await bridge.close();
  }
});

test("reload is a no-op when the config has not changed", async () => {
  const port = await getFreePort();
  const configPath = tempConfig(port, "t");
  const bridge = startBridge({ port, token: "t", configPath, extensionWaitMs: 10 });
  await bridge.ready;
  try {
    const result = await bridge.reloadConfig();
    assert.equal(result.changed, false);
    assert.match(result.detail, /unchanged/);
    assert.equal(bridge.status().port, port);
  } finally {
    await bridge.close();
  }
});

test("reload moves the bridge to the new port", async () => {
  const oldPort = await getFreePort();
  const newPort = await getFreePort();
  const configPath = tempConfig(newPort, "rotated");
  const bridge = startBridge({ port: oldPort, token: "t", configPath });
  await bridge.ready;
  try {
    const result = await bridge.reloadConfig();
    assert.equal(result.changed, true);
    assert.equal(bridge.status().port, newPort);

    // The new port really is serving, and the new token is the one accepted.
    const code = await new Promise<number>((resolve) => {
      const body = JSON.stringify({ type: "tabs.request", id: "x", select: null });
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: newPort,
          path: "/request",
          method: "QUERY",
          agent: false,
          headers: { Connection: "close", "Content-Length": Buffer.byteLength(body) },
        },
        (res) => resolve(res.statusCode ?? 0),
      );
      req.on("error", () => resolve(0));
      req.write(body);
      req.end();
    });
    assert.equal(code, 401, "no token supplied, so the rebound listener must reject it");
  } finally {
    await bridge.close();
  }
});

test("a failed rebind keeps the working listener instead of losing both", async () => {
  const oldPort = await getFreePort();
  const takenPort = await getFreePort();

  // Someone else already owns the port the config points at.
  const squatter = net.createServer();
  await new Promise<void>((resolve) => squatter.listen(takenPort, "127.0.0.1", resolve));

  const configPath = tempConfig(takenPort, "rotated");
  const bridge = startBridge({ port: oldPort, token: "t", configPath });
  await bridge.ready;
  try {
    const result = await bridge.reloadConfig();
    assert.equal(result.changed, false);
    assert.match(result.detail, /already in use/);
    // Still serving on the original port, a failed reload must not strand us.
    assert.equal(bridge.status().port, oldPort);
  } finally {
    await bridge.close();
    await new Promise<void>((resolve) => squatter.close(() => resolve()));
  }
});

test("the disconnect error carries the full diagnosis on its own", async () => {
  const port = await getFreePort();
  const configPath = tempConfig(port, "t");
  const bridge = startBridge({ port, token: "t", configPath, extensionWaitMs: 10 });
  await bridge.ready;
  try {
    await assert.rejects(
      () => bridge.listTabs(null),
      (err: Error) => {
        // A caller must be able to act on this string without a second tool call,
        // because a newly added diagnostic tool is invisible until the client
        // restarts, precisely when something has just changed.
        assert.match(err.message, /listening on 127\.0\.0\.1:/, "states the server is healthy");
        assert.match(err.message, /chrome:\/\/extensions/, "names where to fix it");
        assert.match(err.message, /has not connected since this server started/);
        assert.match(err.message, /retries on its own/, "sets the expectation of self-recovery");
        return true;
      },
    );
  } finally {
    await bridge.close();
  }
});
