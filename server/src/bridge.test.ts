import assert from "node:assert/strict";
import { test } from "node:test";
import { WebSocket } from "ws";
import { startBridge } from "./bridge.ts";

let nextPort = 25000 + (process.pid % 200) * 50 + Math.floor(Math.random() * 40);
function getPort() {
  return nextPort++;
}

test("bridge performs the auth handshake and a read round trip", async () => {
  const port = getPort();
  const token = "integration-test-token";
  const bridge = startBridge({ port, token });
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  try {
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    ws.send(JSON.stringify({ type: "auth", token, extensionVersion: "test" }));
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString()) as { type: string; id: string };
      if (msg.type === "read.request") {
        ws.send(
          JSON.stringify({
            type: "read.response",
            id: msg.id,
            markdown: "hello world",
            refs: [],
            hasPasswordField: false,
          }),
        );
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const res = await bridge.readActiveTab(null);
    assert.equal(res.markdown, "hello world");
  } finally {
    ws.close();
    await bridge.close();
  }
});

test("bridge rejects a request when no extension is connected", async () => {
  const bridge = startBridge({ port: getPort(), token: "t" });
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
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  try {
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    ws.send(JSON.stringify({ type: "auth", token, extensionVersion: "test" }));
    ws.send(JSON.stringify({ type: "access.status", activeGrantCount: 3 }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(counts, [3]);

    const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
    ws.close();
    await closed;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(counts, [3, 0]);
  } finally {
    ws.close();
    await bridge.close();
  }
});

test("a newly authenticated extension replaces the previous connection", async () => {
  const port = getPort();
  const token = "single-active-extension-token";
  const bridge = startBridge({ port, token });
  const first = new WebSocket(`ws://127.0.0.1:${port}`);
  const second = new WebSocket(`ws://127.0.0.1:${port}`);
  try {
    await Promise.all(
      [first, second].map(
        (ws) =>
          new Promise<void>((resolve, reject) => {
            ws.once("open", resolve);
            ws.once("error", reject);
          }),
      ),
    );
    first.send(JSON.stringify({ type: "auth", token, extensionVersion: "test" }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const firstClosed = new Promise<{ code: number; reason: string }>((resolve) => {
      first.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    second.send(JSON.stringify({ type: "auth", token, extensionVersion: "test" }));

    assert.deepEqual(await firstClosed, {
      code: 1000,
      reason: "replaced by a newer extension connection",
    });
  } finally {
    first.close();
    second.close();
    await bridge.close();
  }
});

test("a second bridge on the same port degrades gracefully instead of crashing", async () => {
  const port = getPort();
  const first = startBridge({ port, token: "t" });
  // Same port → EADDRINUSE on the second server. Without the error handler this would crash the
  // process on an unhandled 'error' event; with it, requests reject with a clear message.
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
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  try {
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    ws.send(JSON.stringify({ type: "auth", token, extensionVersion: "test" }));
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString()) as any;
      if (msg.type === "act.request") {
        ws.send(
          JSON.stringify({
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
          }),
        );
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const res = await bridge.actActiveTab({ ref: "r1", action: "click", value: "hello" });
    assert.equal(res.verdict, "dom_changed");
    assert.deepEqual(res.diff.appeared, ["a"]);
  } finally {
    ws.close();
    await bridge.close();
  }
});

test("bridge routes and handles listTabs requests", async () => {
  const port = getPort();
  const token = "tabs-token";
  const bridge = startBridge({ port, token });
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  try {
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    ws.send(JSON.stringify({ type: "auth", token, extensionVersion: "test" }));
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString()) as any;
      if (msg.type === "tabs.request") {
        ws.send(
          JSON.stringify({
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
          }),
        );
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const res = await bridge.listTabs("select-pattern");
    assert.equal(res.tabs.length, 1);
    assert.equal(res.tabs[0]?.title, "Test Tab");
  } finally {
    ws.close();
    await bridge.close();
  }
});

test("bridge rejects connection on token mismatch", async () => {
  const port = getPort();
  const token = "correct-token";
  const bridge = startBridge({ port, token });
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  try {
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    ws.send(JSON.stringify({ type: "auth", token: "wrong-token", extensionVersion: "test" }));

    const code = await new Promise<number>((resolve) => {
      ws.on("close", (code) => resolve(code));
    });
    assert.equal(code, 1008); // Close code 1008 is sent on unauthorized
  } finally {
    ws.close();
    await bridge.close();
  }
});

test("bridge closes connection on auth timeout", async () => {
  const port = getPort();
  const token = "correct-token";

  const originalSetTimeout = globalThis.setTimeout;
  let timeoutCallback: (() => void) | null = null;
  globalThis.setTimeout = ((cb: any, ms: any) => {
    console.log("setTimeout called with ms:", ms);
    // Check if the ms value is 2000 (which matches AUTH_TIMEOUT_MS)
    if (ms === 2000) {
      timeoutCallback = cb;
      return 123456 as any;
    }
    return originalSetTimeout(cb, ms);
  }) as any;

  try {
    const bridge = startBridge({ port, token });
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    try {
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
      });

      // Wait slightly to make sure connection listener is executed
      await new Promise((resolve) => originalSetTimeout(resolve, 80));

      if (timeoutCallback) {
        (timeoutCallback as any)();
      } else {
        // Fallback: wait out the real timeout if callback wasn't intercepted (which shouldn't happen)
        await new Promise((resolve) => originalSetTimeout(resolve, 2100));
      }

      const code = await new Promise<number>((resolve) => {
        ws.on("close", (code) => resolve(code));
      });
      assert.equal(code, 1008);
    } finally {
      ws.close();
      await bridge.close();
    }
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("bridge rejects pending requests if extension disconnects mid-request", async () => {
  const port = getPort();
  const token = "mid-req-token";
  const bridge = startBridge({ port, token });
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  try {
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    ws.send(JSON.stringify({ type: "auth", token, extensionVersion: "test" }));

    // Wait for auth to complete on the server side
    await new Promise((resolve) => setTimeout(resolve, 50));

    // We want to handle when the read.request comes in, but instead of responding, we close the socket.
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString()) as { type: string; id: string };
      if (msg.type === "read.request") {
        ws.close();
      }
    });

    await assert.rejects(() => bridge.readActiveTab(null), /the browsight extension disconnected/);
  } finally {
    ws.close();
    await bridge.close();
  }
});

test("bridge request timeout", async () => {
  const port = getPort();
  const token = "timeout-token";
  const bridge = startBridge({ port, token });
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);

  const originalSetTimeout = globalThis.setTimeout;
  let timeoutCallback: (() => void) | null = null;

  globalThis.setTimeout = ((cb: any, ms: any) => {
    if (ms === 30000) {
      timeoutCallback = cb;
      return 123456 as any;
    }
    return originalSetTimeout(cb, ms);
  }) as any;

  try {
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    ws.send(JSON.stringify({ type: "auth", token, extensionVersion: "test" }));

    // Wait for auth to complete
    await new Promise((resolve) => originalSetTimeout(resolve, 50));

    const requestPromise = bridge.readActiveTab(null);

    // Ensure the timeout callback was registered
    assert.ok(timeoutCallback);

    // Trigger timeout
    (timeoutCallback as any)();

    await assert.rejects(requestPromise, /timed out waiting for the extension/);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    ws.close();
    await bridge.close();
  }
});
