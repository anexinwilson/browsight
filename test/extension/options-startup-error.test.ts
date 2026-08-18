import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM('<!doctype html><div id="status"></div>');
globalThis.window = dom.window as unknown as Window & typeof globalThis;
globalThis.document = dom.window.document;

await import("../../extension/src/options.ts");

test("options page shows initialization failures to the user", () => {
  assert.match(document.getElementById("status")?.textContent ?? "", /missing #timer/);
});
