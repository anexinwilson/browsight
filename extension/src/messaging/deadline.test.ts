import assert from "node:assert/strict";
import test from "node:test";
import { ActionTimeoutError, withDeadline } from "./act.ts";

test("withDeadline reports the action stage instead of hanging", async () => {
  const never = new Promise<never>(() => {});
  await assert.rejects(
    withDeadline(never, "page action", 5),
    (error: unknown) =>
      error instanceof ActionTimeoutError && error.stage === "page action" && error.timeoutMs === 5,
  );
});

test("withDeadline clears its timer when work completes", async () => {
  assert.equal(await withDeadline(Promise.resolve("done"), "page action", 50), "done");
});
