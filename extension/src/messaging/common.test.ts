import assert from "node:assert";
import test from "node:test";
import { originOf } from "./common.ts";

test("originOf returns origin for valid URL", () => {
  assert.strictEqual(originOf("https://example.com/foo/bar"), "https://example.com");
});

test("originOf returns original string for invalid URL (covers lines 53-54)", () => {
  const invalidUrl = "not-a-url";
  assert.strictEqual(originOf(invalidUrl), invalidUrl);
});
