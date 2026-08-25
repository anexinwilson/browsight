import assert from "node:assert/strict";
import { test } from "node:test";
import type { BridgeMessage } from "@browsight/shared";
import { createPendingRequests } from "../../../server/src/bridge/pending-requests.ts";

const response = (id: string): BridgeMessage => ({
  type: "tabs.response",
  id,
  tabs: [],
  refs: [],
  hasPasswordField: false,
});

test("a tracked request is settled by its matching response", async () => {
  const pending = createPendingRequests();
  const settled = new Promise<BridgeMessage>((resolve, reject) => {
    pending.track("a", 1000, resolve, reject);
  });
  assert.equal(pending.size, 1);
  assert.equal(pending.settle("a", response("a")), true);
  const delivered = await settled;
  assert.equal(delivered.type === "tabs.response" ? delivered.id : "", "a");
  // Settling clears the entry and its timer, so the process can exit.
  assert.equal(pending.size, 0);
});

test("a response nobody is waiting for is reported rather than thrown", () => {
  const pending = createPendingRequests();
  assert.equal(pending.settle("unknown", response("unknown")), false);
});

test("a request that outlives its timeout rejects and stops taking up space", async () => {
  const pending = createPendingRequests();
  const settled = new Promise<BridgeMessage>((resolve, reject) => {
    pending.track("slow", 5, resolve, reject);
  });
  await assert.rejects(settled, /timed out waiting for the extension/);
  assert.equal(pending.size, 0);
});

test("rejectAll fails everything in flight, so a disconnect never leaves a promise hanging", async () => {
  const pending = createPendingRequests();
  const first = new Promise<BridgeMessage>((resolve, reject) =>
    pending.track("1", 1000, resolve, reject),
  );
  const second = new Promise<BridgeMessage>((resolve, reject) =>
    pending.track("2", 1000, resolve, reject),
  );
  pending.rejectAll("the browsight extension disconnected");

  await assert.rejects(first, /extension disconnected/);
  await assert.rejects(second, /extension disconnected/);
  assert.equal(pending.size, 0);
});

test("forget drops a request without settling it, for a caller reporting its own failure", async () => {
  const pending = createPendingRequests();
  let outcome = "pending";
  pending.track(
    "x",
    5,
    () => {
      outcome = "resolved";
    },
    () => {
      outcome = "rejected";
    },
  );
  pending.forget("x");
  assert.equal(pending.size, 0);
  // The timer was cleared too, so the abandoned request never rejects late.
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(outcome, "pending");
});
