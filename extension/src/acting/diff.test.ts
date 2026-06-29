import assert from "node:assert/strict";
import { test } from "node:test";
import type { Ref } from "@browsight/shared";
import { computeDiff, selectVerdict } from "./diff.ts";

const ref = (id: number, role: string, name: string, state?: string): Ref => ({
  id,
  role,
  name,
  recipe: { role, name, dataAttrs: {}, text: "", ordinal: 0 },
  ...(state !== undefined ? { state } : {}),
});

test("computeDiff reports appeared and removed interactive elements", () => {
  const before = [ref(1, "button", "Compose")];
  const after = [ref(1, "button", "Compose"), ref(2, "button", "Send")];
  const d = computeDiff(before, after);
  assert.deepEqual(d.appeared, ['button "Send"']);
  assert.deepEqual(d.removed, []);
  assert.deepEqual(d.changed, []);
});

test("computeDiff counts duplicate same-name controls", () => {
  const before = [ref(1, "link", "Reply")];
  const after = [ref(1, "link", "Reply"), ref(2, "link", "Reply"), ref(3, "link", "Reply")];
  const d = computeDiff(before, after);
  assert.deepEqual(d.appeared, ['link "Reply" (x2)']);
  assert.deepEqual(d.removed, []);
});

test("computeDiff reports a state change on a persistent element", () => {
  const before = [ref(1, "button", "Menu", "aria-expanded=false")];
  const after = [ref(1, "button", "Menu", "aria-expanded=true")];
  const d = computeDiff(before, after);
  assert.deepEqual(d.changed, ['button "Menu"']);
  assert.deepEqual(d.appeared, []);
  assert.deepEqual(d.removed, []);
});

test("selectVerdict classifies each outcome", () => {
  assert.equal(selectVerdict("fill", "a", "a", true), "value_set");
  assert.equal(selectVerdict("navigate", "a", "b", false), "navigated");
  assert.equal(selectVerdict("click", "a", "a", false), "no_change");
  assert.equal(selectVerdict("click", "a", "b", false), "dom_changed");
});
