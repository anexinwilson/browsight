/**
 * Covers the bridge's defences against a hostile web page reaching 127.0.0.1:
 * DNS rebinding, cross-origin fetches, and token smuggling.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  EXTENSION_ORIGIN,
  isLoopbackHost,
  parseExtensionOrigin,
  startBridge,
} from "../../server/src/bridge.ts";

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

function request(options: {
  port: number;
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const body = options.body ?? "";
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: options.port,
        path: options.path ?? "/request",
        method: options.method ?? "QUERY",
        agent: false,
        headers: {
          Connection: "close",
          ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}),
          ...options.headers,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk.toString();
        });
        res.on("end", () =>
          resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, body: data }),
        );
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

const TOKEN = "origin-suite-token";

const tabsBody = (id: string) => JSON.stringify({ type: "tabs.request", id, select: null });

async function withBridge(fn: (port: number) => Promise<void>): Promise<void> {
  const port = await getFreePort();
  const bridge = startBridge({
    port,
    token: TOKEN,
    onTabs: (req) => ({
      type: "tabs.response" as const,
      id: req.id,
      tabs: [],
      refs: [],
      hasPasswordField: false,
    }),
  });
  await bridge.ready;
  try {
    await fn(port);
  } finally {
    await bridge.close();
  }
}

test("isLoopbackHost accepts only local names", () => {
  assert.equal(isLoopbackHost("127.0.0.1:8765"), true);
  assert.equal(isLoopbackHost("localhost:8765"), true);
  assert.equal(isLoopbackHost("[::1]:8765"), true);
  assert.equal(isLoopbackHost("127.0.0.1"), true);

  assert.equal(isLoopbackHost("evil.example.com:8765"), false);
  assert.equal(isLoopbackHost("192.168.1.10:8765"), false);
  assert.equal(isLoopbackHost("127.0.0.1.evil.example.com:8765"), false);
  assert.equal(isLoopbackHost(undefined), false);
});

test("the pinned extension origin matches the manifest key", async () => {
  const { createHash } = await import("node:crypto");
  const manifest = JSON.parse(
    readFileSync(resolve(import.meta.dirname, "../../extension/src/manifest.json"), "utf8"),
  );
  assert.ok(manifest.key, "manifest must pin the extension ID with a `key` field");

  // Chrome derives the ID from sha256 of the public key DER: first 32 hex chars,
  // each mapped 0-f -> a-p.
  const der = Buffer.from(manifest.key, "base64");
  const hash = createHash("sha256").update(der).digest("hex").slice(0, 32);
  const derivedId = [...hash].map((c) => String.fromCharCode(Number.parseInt(c, 16) + 97)).join("");

  assert.equal(EXTENSION_ORIGIN, `chrome-extension://${derivedId}`);
});

test("parseExtensionOrigin accepts only the pinned extension origin", () => {
  assert.equal(parseExtensionOrigin(EXTENSION_ORIGIN), EXTENSION_ORIGIN);

  // A well-formed but different extension.
  assert.equal(parseExtensionOrigin(`chrome-extension://${"a".repeat(32)}`), null);
  // Variants a prefix check would accept.
  assert.equal(parseExtensionOrigin("chrome-extension://evil.example.com"), null);
  assert.equal(parseExtensionOrigin(`${EXTENSION_ORIGIN}.evil.example.com`), null);
  assert.equal(parseExtensionOrigin(`${EXTENSION_ORIGIN}/path`), null);
  assert.equal(parseExtensionOrigin(`${EXTENSION_ORIGIN}\r\nX-Injected: 1`), null);
  assert.equal(parseExtensionOrigin("https://example.com"), null);
  assert.equal(parseExtensionOrigin(undefined), null);
});

test("rejects a rebound Host header even with a valid token", async () => {
  await withBridge(async (port) => {
    const res = await request({
      port,
      headers: {
        Host: "evil.example.com",
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: tabsBody("rebind"),
    });
    assert.equal(res.statusCode, 403, "DNS-rebound request must be refused");
    assert.equal(res.body, "forbidden");
  });
});

test("rejects a cross-origin page even with a valid token", async () => {
  await withBridge(async (port) => {
    const res = await request({
      port,
      headers: {
        Origin: "https://evil.example.com",
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: tabsBody("cross-origin"),
    });
    // Must not reach the handler at all, or side effects fire regardless.
    assert.equal(res.statusCode, 403);
    assert.equal(res.headers["access-control-allow-origin"], undefined);
  });
});

test("never emits a wildcard CORS grant", async () => {
  await withBridge(async (port) => {
    const res = await request({
      port,
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: tabsBody("no-wildcard"),
    });
    assert.equal(res.statusCode, 200);
    assert.notEqual(
      res.headers["access-control-allow-origin"],
      "*",
      "a wildcard would expose the bridge to every site the user visits",
    );
    assert.equal(res.headers["access-control-allow-private-network"], undefined);
  });
});

test("allows the extension origin and its preflight", async () => {
  await withBridge(async (port) => {
    const extensionOrigin = EXTENSION_ORIGIN;

    const preflight = await request({
      port,
      method: "OPTIONS",
      headers: { Origin: extensionOrigin },
    });
    assert.equal(preflight.statusCode, 204);
    assert.equal(preflight.headers["access-control-allow-origin"], extensionOrigin);
    assert.equal(preflight.headers["access-control-allow-private-network"], "true");
    assert.equal(preflight.headers.vary, "Origin");

    const res = await request({
      port,
      headers: {
        Origin: extensionOrigin,
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: tabsBody("extension-ok"),
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["access-control-allow-origin"], extensionOrigin);
    assert.equal(JSON.parse(res.body).type, "tabs.response");
  });
});

test("refuses a preflight from a non-extension origin", async () => {
  await withBridge(async (port) => {
    const res = await request({
      port,
      method: "OPTIONS",
      headers: { Origin: "https://evil.example.com" },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.headers["access-control-allow-origin"], undefined);
  });
});

test("a token in the query string does not authenticate", async () => {
  await withBridge(async (port) => {
    const res = await request({
      port,
      path: `/request?token=${TOKEN}`,
      headers: { "Content-Type": "application/json" },
      body: tabsBody("query-token"),
    });
    assert.equal(res.statusCode, 401, "query-string tokens leak via logs and Referer");
  });
});

test("a token in the request body does not authenticate", async () => {
  await withBridge(async (port) => {
    const res = await request({
      port,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "tabs.request", id: "body-token", select: null, token: TOKEN }),
    });
    assert.equal(res.statusCode, 401, "a body token would let a cross-site form post authenticate");
  });
});

test("the X-Browsight-Token header still authenticates", async () => {
  await withBridge(async (port) => {
    const res = await request({
      port,
      headers: { "X-Browsight-Token": TOKEN, "Content-Type": "application/json" },
      body: tabsBody("custom-header"),
    });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).type, "tabs.response");
  });
});

test("a non-bearer Authorization header does not authenticate", async () => {
  await withBridge(async (port) => {
    const res = await request({
      port,
      headers: { Authorization: TOKEN, "Content-Type": "application/json" },
      body: tabsBody("raw-auth"),
    });
    assert.equal(res.statusCode, 401);
  });
});

test("a disconnect reports a stale server rather than blaming the extension", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const home = mkdtempSync(join(tmpdir(), "browsight-stale-"));
  const configPath = join(home, "bridge.json");
  const port = await getFreePort();
  // setup rewrote the config after this server booted.
  writeFileSync(configPath, JSON.stringify({ port: port + 1, token: "rotated" }));

  const bridge = startBridge({ port, token: TOKEN, configPath });
  await bridge.ready;
  try {
    await assert.rejects(() => bridge.listTabs(null), /reconfigured after this server started/);
  } finally {
    await bridge.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("a disconnect with a matching config still points at Chrome", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const home = mkdtempSync(join(tmpdir(), "browsight-fresh-"));
  const configPath = join(home, "bridge.json");
  const port = await getFreePort();
  writeFileSync(configPath, JSON.stringify({ port, token: TOKEN }));

  const bridge = startBridge({ port, token: TOKEN, configPath });
  await bridge.ready;
  try {
    await assert.rejects(() => bridge.listTabs(null), /reload the browsight extension/);
  } finally {
    await bridge.close();
    rmSync(home, { recursive: true, force: true });
  }
});
