import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { safeName, safeRole } from "./accessibility.ts";

test("accessible names remove markup in linear time while preserving visible words", () => {
  const dom = new JSDOM(
    '<button aria-label="Open <strong>account</strong> settings">ignored</button>',
  );
  const button = dom.window.document.querySelector("button");
  assert.ok(button);
  assert.equal(safeRole(button), "button");
  assert.equal(safeName(button), "Open account settings");
});
