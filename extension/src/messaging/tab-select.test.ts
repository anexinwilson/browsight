import assert from "node:assert/strict";
import { test } from "node:test";
import type { Grant } from "../permissions/policy.ts";
import { type TabCandidate, accessLabel, resolveTabSelection, selectTabs } from "./tab-select.ts";

const TABS: TabCandidate[] = [
  { id: 1, title: "Reddit - The heart of the internet", origin: "https://www.reddit.com" },
  { id: 2, title: "(3) LinkedIn", origin: "https://www.linkedin.com" },
  { id: 3, title: "Amazon.com: chargers", origin: "https://www.amazon.com" },
];

// Reddit allowed (read), LinkedIn allowed (full), Amazon NOT whitelisted.
const GRANTS: Grant[] = [
  { origin: "https://www.reddit.com", tier: "read", expiresAt: null },
  { origin: "https://www.linkedin.com", tier: "full", expiresAt: null },
];

test("accessLabel maps an access decision to the wire label", () => {
  assert.equal(accessLabel({ read: true, act: true }), "full");
  assert.equal(accessLabel({ read: true, act: false }), "read");
  assert.equal(accessLabel({ read: false, act: false }), "none");
});

test("selectTabs matches a title or origin substring, case-insensitively", () => {
  assert.deepEqual(
    selectTabs(TABS, "linkedin").map((t) => t.id),
    [2],
  );
  assert.deepEqual(
    selectTabs(TABS, "AMAZON.COM").map((t) => t.id),
    [3],
  );
});

test("selectTabs prefers an exact tab id over a substring match", () => {
  assert.deepEqual(
    selectTabs(TABS, "2").map((t) => t.id),
    [2],
  );
});

test("selectTabs returns every match so the caller can disambiguate", () => {
  // "com" appears in all three origins.
  assert.equal(selectTabs(TABS, "com").length, 3);
  assert.equal(selectTabs(TABS, "nope").length, 0);
  assert.equal(selectTabs(TABS, "   ").length, 0);
});

test("resolveTabSelection switches to a whitelisted tab (read tier is enough)", () => {
  const r = resolveTabSelection(TABS, GRANTS, "reddit", 0);
  assert.equal(r.kind, "switch");
  assert.equal(r.kind === "switch" && r.tab.id, 1);
});

test("resolveTabSelection REFUSES a non-whitelisted tab — no switch", () => {
  const r = resolveTabSelection(TABS, GRANTS, "amazon", 0);
  assert.equal(r.kind, "sentinel");
  assert.equal(r.kind === "sentinel" && r.sentinel.kind, "not_whitelisted");
});

test("resolveTabSelection REFUSES a tab whose grant has expired", () => {
  const expired: Grant[] = [{ origin: "https://www.amazon.com", tier: "read", expiresAt: 100 }];
  const r = resolveTabSelection(TABS, expired, "amazon", 200); // now (200) is past expiry (100)
  assert.equal(r.kind, "sentinel");
  assert.equal(r.kind === "sentinel" && r.sentinel.kind, "not_whitelisted");
});

test("resolveTabSelection refuses an ambiguous selector before any access check", () => {
  const r = resolveTabSelection(TABS, GRANTS, "com", 0); // matches all three
  assert.equal(r.kind, "sentinel");
  assert.equal(r.kind === "sentinel" && r.sentinel.kind, "ambiguous_target");
});

test("resolveTabSelection reports no match", () => {
  const r = resolveTabSelection(TABS, GRANTS, "nope", 0);
  assert.equal(r.kind, "sentinel");
  assert.equal(r.kind === "sentinel" && r.sentinel.kind, "ambiguous_target");
});
