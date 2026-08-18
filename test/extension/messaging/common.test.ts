import assert from "node:assert";
import test from "node:test";
import { originOf } from "../../../extension/src/messaging/common.ts";

test("originOf returns origin for valid URL", () => {
  assert.strictEqual(originOf("https://example.com/foo/bar"), "https://example.com");
});

test("originOf preserves an invalid URL for a useful error message", () => {
  const invalidUrl = "not-a-url";
  assert.strictEqual(originOf(invalidUrl), invalidUrl);
});
