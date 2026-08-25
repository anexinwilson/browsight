import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { startBridge } from "../../server/src/bridge/bridge.ts";
import { isProcessAlive } from "../../server/src/lifecycle/parent-watchdog.ts";

const INDEX_PATH = join(import.meta.dirname, "../../server/src/index.ts");

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

function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
  });
}

function sendHttpQuery(options: {
  port: number;
  token: string;
  path?: string;
  body?: unknown;
  headers?: Record<string, string>;
}): Promise<{
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  json: any;
  durationMs: number;
  socketClosed: boolean;
}> {
  return new Promise((resolve, reject) => {
    const postData =
      options.body !== undefined
        ? typeof options.body === "string"
          ? options.body
          : JSON.stringify(options.body)
        : "";
    const startTime = performance.now();
    let socketClosed = false;

    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: options.port,
        path: options.path ?? "/request",
        method: "QUERY",
        agent: false,
        headers: {
          Authorization: `Bearer ${options.token}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(postData),
          Connection: "close",
          ...options.headers,
        },
      },
      (res) => {
        const socket = res.socket;
        if (socket) {
          if (socket.destroyed || socket.closed) {
            socketClosed = true;
          }
          socket.on("close", () => {
            socketClosed = true;
          });
        }

        let rawData = "";
        res.on("data", (chunk) => {
          rawData += chunk.toString();
        });

        res.on("close", () => {
          socketClosed = true;
        });

        res.on("end", async () => {
          const durationMs = performance.now() - startTime;
          let json: any = null;
          try {
            json = JSON.parse(rawData);
          } catch {}

          if (!socketClosed && socket && !socket.destroyed) {
            await new Promise<void>((r) => {
              socket.once("close", () => {
                socketClosed = true;
                r();
              });
              setTimeout(r, 40);
            });
          }

          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body: rawData,
            json,
            durationMs,
            socketClosed: socketClosed || Boolean(socket?.destroyed || socket?.closed),
          });
        });
      },
    );

    req.on("error", reject);
    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

test("request-and-disconnect bridge: HTTP QUERY fulfills request and immediately closes connection", async () => {
  const port = await getFreePort();
  const token = "unit-request-disconnect-token";
  const bridge = startBridge({
    port,
    token,
    onTabs: (req) => ({
      type: "tabs.response",
      id: req.id,
      tabs: [
        { id: 1, title: "Tab 1", origin: "https://example.com", active: true, access: "full" },
      ],
      refs: [],
      hasPasswordField: false,
    }),
  });
  await bridge.ready;

  try {
    const res = await sendHttpQuery({
      port,
      token,
      body: { type: "tabs.request", id: "query-req-1", select: null },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers.connection, "close");
    assert.equal(res.json?.type, "tabs.response");
    assert.equal(res.json?.id, "query-req-1");
    assert.equal(res.json?.tabs?.[0]?.title, "Tab 1");
    assert.ok(res.socketClosed);
  } finally {
    await bridge.close();
  }
});

test("request-and-disconnect bridge: fulfills multiple sequential HTTP QUERY requests on same active bridge", async () => {
  const port = await getFreePort();
  const token = "unit-seq-token";
  const bridge = startBridge({
    port,
    token,
    onRead: (req) => ({
      type: "read.response",
      id: req.id,
      markdown: `# Content for ${req.id}`,
      refs: [],
      hasPasswordField: false,
      truncated: false,
      nextOffset: 0,
    }),
  });
  await bridge.ready;

  try {
    // 1st sequential request
    const res1 = await sendHttpQuery({
      port,
      token,
      body: { type: "read.request", id: "seq-1", url: null, mode: "full", schema: null },
    });
    assert.equal(res1.statusCode, 200);
    assert.equal(res1.headers.connection, "close");
    assert.equal(res1.json?.id, "seq-1");
    assert.equal(res1.json?.markdown, "# Content for seq-1");
    assert.ok(res1.socketClosed);

    // 2nd sequential request
    const res2 = await sendHttpQuery({
      port,
      token,
      body: { type: "read.request", id: "seq-2", url: null, mode: "full", schema: null },
    });
    assert.equal(res2.statusCode, 200);
    assert.equal(res2.headers.connection, "close");
    assert.equal(res2.json?.id, "seq-2");
    assert.equal(res2.json?.markdown, "# Content for seq-2");
    assert.ok(res2.socketClosed);

    // 3rd sequential request
    const res3 = await sendHttpQuery({
      port,
      token,
      body: { type: "read.request", id: "seq-3", url: null, mode: "full", schema: null },
    });
    assert.equal(res3.statusCode, 200);
    assert.equal(res3.headers.connection, "close");
    assert.equal(res3.json?.id, "seq-3");
    assert.equal(res3.json?.markdown, "# Content for seq-3");
    assert.ok(res3.socketClosed);
  } finally {
    await bridge.close();
  }
});

test("request-and-disconnect bridge: SSE HTTP QUERY fulfills request and immediately terminates stream", async () => {
  const port = await getFreePort();
  const token = "unit-sse-token";
  const bridge = startBridge({
    port,
    token,
    onAct: (req) => ({
      type: "act.response",
      id: req.id,
      verdict: "dom_changed",
      diff: { appeared: ["New Button"], removed: [], changed: [] },
      refs: [],
    }),
  });
  await bridge.ready;

  try {
    const res = await sendHttpQuery({
      port,
      token,
      headers: { Accept: "text/event-stream" },
      body: { type: "act.request", id: "sse-act-1", ref: "btn-1", action: "click" },
    });

    assert.equal(res.statusCode, 200);
    assert.match(res.headers["content-type"] ?? "", /text\/event-stream/);
    assert.equal(res.headers.connection, "close");
    assert.match(res.body, /act\.response/);
    assert.match(res.body, /sse-act-1/);
    assert.ok(res.socketClosed);
  } finally {
    await bridge.close();
  }
});

test("request-and-disconnect bridge: unauthorized requests return 401 and close connection immediately", async () => {
  const port = await getFreePort();
  const token = "correct-auth-token";
  const bridge = startBridge({ port, token });
  await bridge.ready;

  try {
    const res = await sendHttpQuery({
      port,
      token: "wrong-token",
      body: { type: "tabs.request", id: "unauth-1", select: null },
    });

    assert.equal(res.statusCode, 401);
    assert.equal(res.headers.connection, "close");
    assert.ok(res.socketClosed);
  } finally {
    await bridge.close();
  }
});

test("the daemon starts without binding a port, so a second MCP client can still start", async () => {
  const testHome = join(tmpdir(), `browsight-lazy-${Date.now()}-${randomBytes(4).toString("hex")}`);
  mkdirSync(join(testHome, ".browsight"), { recursive: true });
  const port = await getFreePort();
  writeFileSync(
    join(testHome, ".browsight", "bridge.json"),
    JSON.stringify({ port, token: "lazy-token" }),
  );

  const child = spawn(process.execPath, [INDEX_PATH], {
    env: { ...process.env, BROWSIGHT_HOME: testHome, HOME: testHome, USERPROFILE: testHome },
    stdio: ["pipe", "pipe", "pipe"],
  });

  try {
    const daemonPid = child.pid;
    assert.ok(daemonPid !== undefined && daemonPid > 0);

    // Give it well past the time it used to take to bind at startup.
    await new Promise((resolve) => setTimeout(resolve, 1200));

    assert.equal(
      await probePort(port),
      false,
      "an unused browsight must hold no port, that is what let a second client fail to start",
    );
    assert.equal(
      isProcessAlive(daemonPid),
      true,
      "the daemon stays alive, it just does not listen",
    );

    // A second daemon on the same config must therefore start cleanly too.
    const second = spawn(process.execPath, [INDEX_PATH], {
      env: { ...process.env, BROWSIGHT_HOME: testHome, HOME: testHome, USERPROFILE: testHome },
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      assert.ok(
        second.pid !== undefined && isProcessAlive(second.pid),
        "a second client's daemon must not be blocked",
      );
    } finally {
      try {
        second.kill("SIGKILL");
      } catch {}
    }
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {}
    try {
      rmSync(testHome, { recursive: true, force: true });
    } catch {}
  }
});
