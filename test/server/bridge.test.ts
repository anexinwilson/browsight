import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { startBridge } from "../../server/src/bridge.ts";

let nextPort = 25000 + (process.pid % 200) * 50 + Math.floor(Math.random() * 40);
function getPort() {
  return nextPort++;
}

function httpRequest(options: {
  port: number;
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: any;
}): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string; json: any }> {
  return new Promise((resolve, reject) => {
    const method = options.method ?? "QUERY";
    const postData =
      options.body !== undefined
        ? typeof options.body === "string"
          ? options.body
          : JSON.stringify(options.body)
        : "";
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: options.port,
        path: options.path ?? "/message",
        method,
        headers: {
          ...(postData
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(postData),
              }
            : {}),
          ...options.headers,
        },
      },
      (res) => {
        let rawData = "";
        res.on("data", (chunk) => {
          rawData += chunk;
        });
        res.on("end", () => {
          let json: any = null;
          try {
            json = JSON.parse(rawData);
          } catch {}
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body: rawData,
            json,
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

function connectSse(options: {
  port: number;
  token: string;
  path?: string;
  method?: string;
}): Promise<{
  req: http.ClientRequest;
  res: http.IncomingMessage;
  events: any[];
  onMessage: (cb: (event: any) => void) => void;
  closedPromise: Promise<void>;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    const events: any[] = [];
    const listeners: ((event: any) => void)[] = [];
    let closedResolve!: () => void;
    const closedPromise = new Promise<void>((res) => {
      closedResolve = res;
    });

    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: options.port,
        path: options.path ?? "/events",
        method: options.method ?? "QUERY",
        headers: {
          Authorization: `Bearer ${options.token}`,
          Accept: "text/event-stream",
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`SSE connection failed with status ${res.statusCode}`));
          return;
        }

        res.on("close", () => {
          closedResolve();
        });
        res.on("end", () => {
          closedResolve();
        });

        let buffer = "";
        res.on("data", (chunk) => {
          buffer += chunk.toString();
          const blocks = buffer.split("\n\n");
          buffer = blocks.pop() ?? "";
          for (const block of blocks) {
            for (const line of block.split("\n")) {
              if (line.startsWith("data: ")) {
                const raw = line.slice(6).trim();
                try {
                  const parsed = JSON.parse(raw);
                  events.push(parsed);
                  for (const cb of listeners) {
                    cb(parsed);
                  }
                } catch {}
              }
            }
          }
        });

        resolve({
          req,
          res,
          events,
          onMessage: (cb) => listeners.push(cb),
          closedPromise,
          close: () => {
            req.destroy();
          },
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("bridge performs the auth handshake and a read round trip", async () => {
  const port = getPort();
  const token = "integration-test-token";
  const bridge = startBridge({ port, token });
  await bridge.ready;

  const sse = await connectSse({ port, token });
  try {
    sse.onMessage(async (msg) => {
      if (msg.type === "read.request") {
        await httpRequest({
          port,
          method: "QUERY",
          path: "/message",
          headers: { Authorization: `Bearer ${token}` },
          body: {
            type: "read.response",
            id: msg.id,
            markdown: "hello world",
            refs: [],
            hasPasswordField: false,
          },
        });
      }
    });

    const res = await bridge.readActiveTab(null);
    assert.equal(res.markdown, "hello world");
  } finally {
    sse.close();
    await bridge.close();
  }
});

test("bridge rejects a request when no extension is connected", async () => {
  const bridge = startBridge({ port: getPort(), token: "t" });
  await bridge.ready;
  try {
    await assert.rejects(() => bridge.readActiveTab(null), /not connected/);
  } finally {
    await bridge.close();
  }
});

test("bridge reports grant-count status and treats a disconnect as unavailable access", async () => {
  const port = getPort();
  const token = "access-status-token";
  const counts: number[] = [];
  const bridge = startBridge({
    port,
    token,
    onAccessStatus: (activeGrantCount) => counts.push(activeGrantCount),
  });
  await bridge.ready;

  const sse = await connectSse({ port, token });
  try {
    await httpRequest({
      port,
      method: "QUERY",
      path: "/message",
      headers: { Authorization: `Bearer ${token}` },
      body: { type: "access.status", activeGrantCount: 3 },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(counts, [3]);

    sse.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(counts, [3, 0]);
  } finally {
    sse.close();
    await bridge.close();
  }
});

test("a newly authenticated extension replaces the previous connection", async () => {
  const port = getPort();
  const token = "single-active-extension-token";
  const bridge = startBridge({ port, token });
  await bridge.ready;

  const first = await connectSse({ port, token });
  const second = await connectSse({ port, token });

  let firstClosed = false;
  first.closedPromise.then(() => {
    firstClosed = true;
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    // First connection must be closed when a second authenticates
    await first.closedPromise;
    assert.strictEqual(firstClosed, true, "First SSE connection must be closed upon replacement");
  } finally {
    first.close();
    second.close();
    await bridge.close();
  }
});

test("a second bridge on the same port degrades gracefully instead of crashing", async () => {
  const port = getPort();
  const first = startBridge({ port, token: "t" });
  await first.ready;

  const second = startBridge({ port, token: "t" });
  try {
    await assert.rejects(second.ready, /only one client can drive browsight/);
    await assert.rejects(() => second.readActiveTab(null), /only one client can drive browsight/);
  } finally {
    await first.close();
    await second.close();
  }
});

test("bridge routes and handles actActiveTab requests", async () => {
  const port = getPort();
  const token = "act-token";
  const bridge = startBridge({ port, token });
  await bridge.ready;

  const sse = await connectSse({ port, token });
  try {
    sse.onMessage(async (msg) => {
      if (msg.type === "act.request") {
        await httpRequest({
          port,
          method: "QUERY",
          path: "/message",
          headers: { Authorization: `Bearer ${token}` },
          body: {
            type: "act.response",
            id: msg.id,
            verdict: "dom_changed",
            diff: { appeared: ["a"], removed: ["b"], changed: ["c"] },
            refs: [
              {
                id: 1,
                role: "button",
                name: "test-btn",
                recipe: { role: "button", name: "test-btn", text: "", ordinal: 0, dataAttrs: {} },
              },
            ],
          },
        });
      }
    });

    const res = await bridge.actActiveTab({ ref: "r1", action: "click", value: "hello" });
    assert.equal(res.verdict, "dom_changed");
    assert.deepEqual(res.diff.appeared, ["a"]);
  } finally {
    sse.close();
    await bridge.close();
  }
});

test("bridge routes and handles listTabs requests", async () => {
  const port = getPort();
  const token = "tabs-token";
  const bridge = startBridge({ port, token });
  await bridge.ready;

  const sse = await connectSse({ port, token });
  try {
    sse.onMessage(async (msg) => {
      if (msg.type === "tabs.request") {
        await httpRequest({
          port,
          method: "QUERY",
          path: "/message",
          headers: { Authorization: `Bearer ${token}` },
          body: {
            type: "tabs.response",
            id: msg.id,
            tabs: [
              {
                id: 1,
                title: "Test Tab",
                origin: "https://example.com",
                active: true,
                access: "full",
              },
            ],
          },
        });
      }
    });

    const res = await bridge.listTabs("select-pattern");
    assert.equal(res.tabs.length, 1);
    assert.equal(res.tabs[0]?.title, "Test Tab");
  } finally {
    sse.close();
    await bridge.close();
  }
});

test("bridge rejects connection on token mismatch", async () => {
  const port = getPort();
  const token = "correct-token";
  const bridge = startBridge({ port, token });
  await bridge.ready;

  try {
    const res = await httpRequest({
      port,
      method: "QUERY",
      path: "/message",
      headers: { Authorization: "Bearer wrong-token" },
      body: { type: "auth", token: "wrong-token", extensionVersion: "test" },
    });
    assert.equal(res.statusCode, 401);
  } finally {
    await bridge.close();
  }
});

test("bridge rejects pending requests if extension disconnects mid-request", async () => {
  const port = getPort();
  const token = "mid-req-token";
  const bridge = startBridge({ port, token });
  await bridge.ready;

  const sse = await connectSse({ port, token });
  try {
    sse.onMessage((msg) => {
      if (msg.type === "read.request") {
        sse.close();
      }
    });

    await assert.rejects(() => bridge.readActiveTab(null), /the browsight extension disconnected/);
  } finally {
    sse.close();
    await bridge.close();
  }
});

test("bridge request timeout", async () => {
  const port = getPort();
  const token = "timeout-token";
  const bridge = startBridge({ port, token });
  await bridge.ready;

  const originalSetTimeout = globalThis.setTimeout;
  let timeoutCallback: (() => void) | null = null;

  globalThis.setTimeout = ((cb: any, ms: any) => {
    if (ms === 30000) {
      timeoutCallback = cb;
      return 123456 as any;
    }
    return originalSetTimeout(cb, ms);
  }) as any;

  const sse = await connectSse({ port, token });
  try {
    const requestPromise = bridge.readActiveTab(null);
    assert.ok(timeoutCallback);
    (timeoutCallback as any)();
    await assert.rejects(requestPromise, /timed out waiting for the extension/);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    sse.close();
    await bridge.close();
  }
});

test("stateless gateway: client connects via HTTP QUERY, sends request, receives response, connection is closed by server, and daemon accepts second sequential request", async () => {
  const port = getPort();
  const token = "stateless-token";
  const bridge = startBridge({
    port,
    token,
    onTabs: (req) => ({
      type: "tabs.response",
      id: req.id,
      tabs: [
        {
          id: 42,
          title: "Browsight Test Page",
          origin: "https://browsight.internal",
          active: true,
          access: "full",
        },
      ],
      refs: [],
      hasPasswordField: false,
    }),
  });
  await bridge.ready;

  try {
    // --- Sequential Cycle 1 ---
    const resp1 = await httpRequest({
      port,
      method: "QUERY",
      path: "/request",
      headers: { Authorization: `Bearer ${token}` },
      body: {
        type: "tabs.request",
        id: "req-1",
        select: null,
      },
    });

    assert.equal(resp1.statusCode, 200);
    assert.equal(resp1.headers.connection, "close");
    assert.equal(resp1.json?.type, "tabs.response");
    assert.equal(resp1.json?.id, "req-1");
    assert.equal(resp1.json?.tabs?.[0]?.title, "Browsight Test Page");

    // --- Sequential Cycle 2 (Daemon remains active and fulfills second request) ---
    const resp2 = await httpRequest({
      port,
      method: "QUERY",
      path: "/request",
      headers: { Authorization: `Bearer ${token}` },
      body: {
        type: "tabs.request",
        id: "req-2",
        select: null,
      },
    });

    assert.equal(resp2.statusCode, 200);
    assert.equal(resp2.headers.connection, "close");
    assert.equal(resp2.json?.type, "tabs.response");
    assert.equal(resp2.json?.id, "req-2");
    assert.equal(resp2.json?.tabs?.[0]?.id, 42);
  } finally {
    await bridge.close();
  }
});

test("stateless gateway: handles read.request and act.request with server-side closure", async () => {
  const port = getPort();
  const token = "stateless-read-act-token";
  const bridge = startBridge({
    port,
    token,
    onRead: (req) => ({
      type: "read.response",
      id: req.id,
      markdown: "# Header\nStateless read content",
      refs: [
        {
          id: 10,
          role: "button",
          name: "Submit",
          recipe: { role: "button", name: "Submit", dataAttrs: {}, text: "", ordinal: 0 },
        },
      ],
      hasPasswordField: false,
    }),
    onAct: (req) => ({
      type: "act.response",
      id: req.id,
      verdict: "dom_changed",
      diff: { appeared: ["New Element"], removed: [], changed: [] },
      refs: [],
    }),
  });
  await bridge.ready;

  try {
    // 1. Read request
    const readResp = await httpRequest({
      port,
      method: "QUERY",
      path: "/request",
      headers: { Authorization: `Bearer ${token}` },
      body: {
        type: "read.request",
        id: "read-1",
        url: null,
        mode: "full",
        schema: null,
      },
    });

    assert.equal(readResp.statusCode, 200);
    assert.equal(readResp.headers.connection, "close");
    assert.equal(readResp.json?.type, "read.response");
    assert.equal(readResp.json?.id, "read-1");
    assert.equal(readResp.json?.markdown, "# Header\nStateless read content");

    // 2. Act request
    const actResp = await httpRequest({
      port,
      method: "QUERY",
      path: "/request",
      headers: { Authorization: `Bearer ${token}` },
      body: {
        type: "act.request",
        id: "act-1",
        ref: "10",
        action: "click",
      },
    });

    assert.equal(actResp.statusCode, 200);
    assert.equal(actResp.headers.connection, "close");
    assert.equal(actResp.json?.type, "act.response");
    assert.equal(actResp.json?.id, "act-1");
    assert.equal(actResp.json?.verdict, "dom_changed");
    assert.deepEqual(actResp.json?.diff?.appeared, ["New Element"]);
  } finally {
    await bridge.close();
  }
});

test("stateless gateway: SSE response stream closes upon fulfillment", async () => {
  const port = getPort();
  const token = "stateless-sse-token";
  const bridge = startBridge({
    port,
    token,
    onRead: (req) => ({
      type: "read.response",
      id: req.id,
      markdown: "sse formatted response",
      refs: [],
      hasPasswordField: false,
    }),
  });
  await bridge.ready;

  try {
    const sseResp = await httpRequest({
      port,
      method: "QUERY",
      path: "/request",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "text/event-stream",
      },
      body: {
        type: "read.request",
        id: "sse-read-1",
        url: null,
        mode: "full",
        schema: null,
      },
    });

    assert.equal(sseResp.statusCode, 200);
    assert.equal(sseResp.headers["content-type"], "text/event-stream");
    assert.equal(sseResp.headers.connection, "close");
    assert.match(sseResp.body, /sse formatted response/);
  } finally {
    await bridge.close();
  }
});

test("the bridge answers QUERY only, so a page cannot reach it with a simple request", async () => {
  const port = getPort();
  const token = "method-token";
  const bridge = startBridge({ port, token });
  await bridge.ready;
  try {
    // GET and POST are CORS simple requests: a form, an image tag or a bare fetch can produce
    // them cross-site. Refusing them removes that route before the token is even read.
    for (const method of ["GET", "POST", "PUT", "DELETE", "HEAD"]) {
      const res = await httpRequest({
        port,
        method,
        path: "/message",
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.strictEqual(res.statusCode, 403, `${method} must be refused`);
    }
    // QUERY with the right token is accepted.
    const ok = await httpRequest({
      port,
      method: "QUERY",
      path: "/message",
      headers: { Authorization: `Bearer ${token}` },
      body: { type: "access.status", activeGrantCount: 0 },
    });
    assert.notStrictEqual(ok.statusCode, 403, "QUERY must not be refused");
  } finally {
    await bridge.close();
  }
});
