import assert from "node:assert/strict";
import { test } from "node:test";
import { type Grant, decideAccess } from "./policy.ts";

const NOW = 1_000_000;

test("a non-whitelisted origin is denied read and act", () => {
  assert.deepEqual(decideAccess([], "https://example.com", NOW), { read: false, act: false });
});

test("a read-only grant allows read but not act", () => {
  const grants: Grant[] = [{ origin: "https://example.com", tier: "read", expiresAt: null }];
  assert.deepEqual(decideAccess(grants, "https://example.com", NOW), { read: true, act: false });
});

test("a full-control grant allows read and act", () => {
  const grants: Grant[] = [{ origin: "https://example.com", tier: "full", expiresAt: null }];
  assert.deepEqual(decideAccess(grants, "https://example.com", NOW), { read: true, act: true });
});

test("an expired grant is denied", () => {
  const grants: Grant[] = [{ origin: "https://example.com", tier: "full", expiresAt: NOW - 1 }];
  assert.deepEqual(decideAccess(grants, "https://example.com", NOW), { read: false, act: false });
});

test("an unexpired timed grant is honored", () => {
  const grants: Grant[] = [{ origin: "https://example.com", tier: "read", expiresAt: NOW + 1000 }];
  assert.deepEqual(decideAccess(grants, "https://example.com", NOW), { read: true, act: false });
});
