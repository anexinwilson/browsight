import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><body></body>");
globalThis.window = dom.window as unknown as Window & typeof globalThis;
globalThis.document = dom.window.document;

const logged: unknown[][] = [];
const originalConsoleError = console.error;
console.error = (...values: unknown[]) => {
  logged.push(values);
};
globalThis.chrome = {
  tabs: {
    async query() {
      return [{ id: 1, url: "https://example.com" } as chrome.tabs.Tab];
    },
  },
} as unknown as typeof chrome;

await import("../../extension/src/popup.ts");

test("popup reports initialization failures without an unhandled rejection", () => {
  try {
    assert.equal(logged[0]?.[0], "browsight popup failed");
    assert.match(String(logged[0]?.[1]), /missing #origin/);
  } finally {
    console.error = originalConsoleError;
  }
});
