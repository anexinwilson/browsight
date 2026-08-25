import assert from "node:assert/strict";
import * as http from "node:http";
import { test } from "node:test";
import { describeListenError, startListener } from "../../../server/src/bridge/listener.ts";

const ok = (_req: http.IncomingMessage, res: http.ServerResponse) => {
  res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
};

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = http.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

function get(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/" }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

test("a listener binds, reports the port it actually holds, and serves", async (t) => {
  const listener = startListener(ok, "127.0.0.1", 0);
  t.after(() => listener.close());
  await listener.ready;

  // Port 0 asks the OS to choose, so the bound port is the only truthful answer.
  assert.ok(listener.port() > 0);
  assert.equal(listener.error(), null);
  assert.equal(await get(listener.port()), 200);
});

test("moving to a free port serves there and releases the old one", async (t) => {
  const listener = startListener(ok, "127.0.0.1", 0);
  t.after(() => listener.close());
  await listener.ready;
  const before = listener.port();

  const next = await freePort();
  await listener.moveTo(next);

  assert.equal(listener.port(), next);
  assert.equal(await get(next), 200);
  await assert.rejects(get(before), "the old port must be released");
});

test("a move onto a taken port fails without dropping the working listener", async (t) => {
  const blocker = http.createServer(ok);
  const blocked = await freePort();
  await new Promise<void>((resolve) => blocker.listen(blocked, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => blocker.close(() => resolve())));

  const listener = startListener(ok, "127.0.0.1", 0);
  t.after(() => listener.close());
  await listener.ready;
  const original = listener.port();

  await assert.rejects(listener.moveTo(blocked));
  // The point of binding the replacement first: a failed move leaves a working bridge, not none.
  assert.equal(listener.port(), original);
  assert.equal(await get(original), 200);
});

test("a port already in use is reported as something the user can act on", async (t) => {
  const blocker = http.createServer(ok);
  const taken = await freePort();
  await new Promise<void>((resolve) => blocker.listen(taken, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => blocker.close(() => resolve())));

  const listener = startListener(ok, "127.0.0.1", taken);
  t.after(() => listener.close());

  await assert.rejects(listener.ready, /another browsight instance is already using/);
  assert.match(listener.error() ?? "", /only one client can drive browsight at a time/);
});

test("listen failures other than a taken port keep their own message", () => {
  const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });
  assert.match(describeListenError(denied, "127.0.0.1", 80), /could not start: permission denied/);
});
