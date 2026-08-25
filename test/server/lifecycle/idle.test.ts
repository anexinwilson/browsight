import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createIdleController,
  parseIdleTimeoutMinutes,
} from "../../../server/src/lifecycle/idle.ts";

test("parseIdleTimeoutMinutes supports both flag forms and zero", () => {
  assert.equal(parseIdleTimeoutMinutes([]), 30);
  assert.equal(parseIdleTimeoutMinutes([], 30), 30);
  assert.equal(parseIdleTimeoutMinutes(["--idle-timeout", "15"]), 15);
  assert.equal(parseIdleTimeoutMinutes(["--idle-timeout=2.5"]), 2.5);
  assert.equal(parseIdleTimeoutMinutes(["--idle-timeout", "0"]), 0);
  assert.throws(() => parseIdleTimeoutMinutes(["--idle-timeout", "nope"]), /non-negative/);
});

test("idle controller resets on activity and can be disabled", async () => {
  let idleCalls = 0;
  const controller = createIdleController(0.01, () => {
    idleCalls++;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.touch();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(idleCalls, 0);
  await new Promise((resolve) => setTimeout(resolve, 550));
  assert.equal(idleCalls, 1);
  controller.stop();

  const disabled = createIdleController(0, () => {
    idleCalls++;
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(idleCalls, 1);
  disabled.stop();
});
