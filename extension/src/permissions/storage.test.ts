import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { Grant } from "./policy.ts";

const STORAGE_KEY = "browsight.grants";
let stored: Grant[] | string = [];
let permissionResult = true;
const requested: string[][] = [];
const removed: string[][] = [];

globalThis.chrome = {
  storage: {
    local: {
      async get() {
        return { [STORAGE_KEY]: stored };
      },
      async set(values: Record<string, unknown>) {
        stored = values[STORAGE_KEY] as Grant[];
      },
    },
  },
  permissions: {
    async request(details: chrome.permissions.Permissions) {
      requested.push(details.origins ?? []);
      return permissionResult;
    },
    async remove(details: chrome.permissions.Permissions) {
      removed.push(details.origins ?? []);
      return true;
    },
  },
} as typeof chrome;

const { grantSite, listGrants, revokeSite, saveGrants, touchGrant } = await import("./storage.ts");

beforeEach(() => {
  stored = [];
  permissionResult = true;
  requested.length = 0;
  removed.length = 0;
});

test("listGrants ignores malformed storage and removes expired host permissions", async () => {
  stored = "not an array";
  assert.deepEqual(await listGrants(), []);

  stored = [
    { origin: "https://live.example", tier: "read", expiresAt: null },
    { origin: "https://expired.example", tier: "full", expiresAt: 0 },
  ];
  assert.deepEqual(await listGrants(), [
    { origin: "https://live.example", tier: "read", expiresAt: null },
  ]);
  assert.deepEqual(removed, [["https://expired.example/*"]]);
});

test("saveGrants and grantSite persist an approved replacement", async () => {
  await saveGrants([{ origin: "https://old.example", tier: "read", expiresAt: null }]);
  const approved = await grantSite({
    origin: "https://old.example",
    tier: "full",
    expiresAt: null,
  });
  assert.equal(approved, true);
  assert.deepEqual(stored, [{ origin: "https://old.example", tier: "full", expiresAt: null }]);
  assert.deepEqual(requested, [["https://old.example/*"]]);
});

test("grantSite rolls storage back when Chrome declines permission", async () => {
  stored = [{ origin: "https://kept.example", tier: "read", expiresAt: null }];
  permissionResult = false;
  const approved = await grantSite({
    origin: "https://denied.example",
    tier: "full",
    expiresAt: null,
  });
  assert.equal(approved, false);
  assert.deepEqual(stored, [{ origin: "https://kept.example", tier: "read", expiresAt: null }]);
});

test("revokeSite removes both the stored grant and host permission", async () => {
  stored = [
    { origin: "https://remove.example", tier: "full", expiresAt: null },
    { origin: "https://keep.example", tier: "read", expiresAt: null },
  ];
  await revokeSite("https://remove.example");
  assert.deepEqual(stored, [{ origin: "https://keep.example", tier: "read", expiresAt: null }]);
  assert.deepEqual(removed, [["https://remove.example/*"]]);
});

test("touchGrant renews a temporary grant after authorized activity", async () => {
  const now = Date.now();
  stored = [
    {
      origin: "https://active.example",
      tier: "full",
      expiresAt: now + 10_000,
      idleTimeoutMs: 3_600_000,
    },
    { origin: "https://persistent.example", tier: "read", expiresAt: null, idleTimeoutMs: null },
  ];

  await touchGrant("https://active.example", now);

  assert.deepEqual(stored, [
    {
      origin: "https://active.example",
      tier: "full",
      expiresAt: now + 3_600_000,
      idleTimeoutMs: 3_600_000,
    },
    { origin: "https://persistent.example", tier: "read", expiresAt: null, idleTimeoutMs: null },
  ]);
});
