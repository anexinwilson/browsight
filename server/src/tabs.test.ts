import assert from "node:assert/strict";
import { test } from "node:test";
import type { TabInfo } from "@browsight/shared";
import { formatTabs } from "./tabs.ts";

const tab = (over: Partial<TabInfo>): TabInfo => ({
  id: 1,
  title: "Example",
  origin: "https://example.com",
  active: false,
  access: "none",
  ...over,
});

test("formatTabs marks the active tab and spells out each access tier", () => {
  const out = formatTabs([
    tab({ id: 1, title: "Reddit", origin: "https://www.reddit.com", active: true, access: "full" }),
    tab({ id: 2, title: "Bank", origin: "https://bank.example", access: "none" }),
    tab({ id: 3, title: "Docs", origin: "https://docs.example", access: "read" }),
  ]);
  assert.match(out, /\* Reddit — https:\/\/www\.reddit\.com \(full control\)/);
  assert.match(out, /- Bank — https:\/\/bank\.example \(not allowed — whitelist to use\)/);
  assert.match(out, /- Docs — https:\/\/docs\.example \(read-only\)/);
});

test("formatTabs handles no open tabs", () => {
  assert.equal(formatTabs([]), "No open http(s) tabs.");
});
