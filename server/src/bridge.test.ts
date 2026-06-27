import assert from "node:assert/strict";
import { test } from "node:test";
import { WebSocket } from "ws";
import { startBridge } from "./bridge.ts";

/**
 * Integration test for the bridge: a fake extension connects over WebSocket, completes the token
 * handshake, and answers a read.request — exercising auth + request/response correlation end to end
 * at the Node level (no Chrome required).
 */
test("bridge performs the auth handshake and a read round trip", async () => {
  const port = 8242;
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
  const bridge = startBridge({ port: 8243, token: "t" });
  try {
    await assert.rejects(() => bridge.readActiveTab(null), /not connected/);
  } finally {
    await bridge.close();
  }
});
