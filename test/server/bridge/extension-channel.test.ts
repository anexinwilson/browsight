import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type * as http from "node:http";
import { test } from "node:test";
import type { BridgeMessage } from "@browsight/shared";
import { createExtensionChannel } from "../../../server/src/bridge/extension-channel.ts";

/** A response/request pair standing in for one extension stream. */
function fakeStream() {
  const written: string[] = [];
  const req = new EventEmitter() as http.IncomingMessage;
  const res = Object.assign(new EventEmitter(), {
    writeHead: () => res,
    write: (chunk: string) => {
      written.push(chunk);
      return true;
    },
    end: () => {
      res.emit("close");
      return res;
    },
  }) as unknown as http.ServerResponse;
  return { req, res, written };
}

const message: BridgeMessage = { type: "access.status", activeGrantCount: 1 };

test("attaching a stream marks the extension connected and greets it", () => {
  const channel = createExtensionChannel();
  assert.equal(channel.isConnected(), false);

  const { req, res, written } = fakeStream();
  channel.attach(res, req, () => {});

  assert.equal(channel.isConnected(), true);
  assert.ok(written.some((c) => c.includes(": connected")));
});

test("a waiter is released the moment the extension attaches", async () => {
  // Regression: waiters were only drained on shutdown, so a caller that arrived before the
  // extension waited the entire 70s window and then found the stream had been live almost all of
  // it. Every cold start paid the full timeout.
  const channel = createExtensionChannel();
  const waiting = channel.awaitConnection(60_000);

  const { req, res } = fakeStream();
  channel.attach(res, req, () => {});

  assert.equal(await waiting, true, "awaitConnection must resolve on attach, not on timeout");
});

test("waiting when already connected resolves immediately", async () => {
  const channel = createExtensionChannel();
  const { req, res } = fakeStream();
  channel.attach(res, req, () => {});
  assert.equal(await channel.awaitConnection(0), true);
});

test("waiting with no extension gives up after the window", async () => {
  const channel = createExtensionChannel();
  assert.equal(await channel.awaitConnection(5), false);
});

test("sending reaches the stream, and fails loudly when nothing is attached", () => {
  const channel = createExtensionChannel();
  assert.throws(() => channel.send(message), /not connected/);

  const { req, res, written } = fakeStream();
  channel.attach(res, req, () => {});
  channel.send(message);

  const event = written.find((c) => c.startsWith("event: message"));
  assert.ok(event, "the message must be written as an SSE event");
  assert.match(event, /access\.status/);
});

test("a dropped connection detaches once and reports it", () => {
  const channel = createExtensionChannel();
  const { req, res } = fakeStream();
  let detaches = 0;
  channel.attach(res, req, () => {
    detaches++;
  });

  req.emit("close");
  req.emit("aborted");

  assert.equal(channel.isConnected(), false);
  assert.equal(detaches, 1, "several close signals for one stream must report a single detach");
});

test("a newer connection replaces the previous one", () => {
  const channel = createExtensionChannel();
  const first = fakeStream();
  channel.attach(first.res, first.req, () => {});
  const second = fakeStream();
  channel.attach(second.res, second.req, () => {});

  assert.ok(first.written.some((c) => c.includes("replaced by a newer extension connection")));
  assert.equal(channel.isConnected(), true);

  // The retired stream closing must not report the live one as gone.
  first.req.emit("close");
  assert.equal(channel.isConnected(), true);
});

test("closing releases anyone still waiting instead of hanging the shutdown", async () => {
  const channel = createExtensionChannel();
  const waiting = channel.awaitConnection(60_000);
  channel.close();
  assert.equal(await waiting, false);
  assert.equal(channel.isConnected(), false);
});
