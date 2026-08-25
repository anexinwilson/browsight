import assert from "node:assert/strict";
import { test } from "node:test";
import type { Ref } from "@browsight/shared";
import { computeDiff, selectVerdict } from "../../../extension/src/acting/diff.ts";

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

test("a change below the snapshot cap is reported even when the markdown compares equal", () => {
  // On a dense page the markdown is truncated, so two genuinely different pages produce identical
  // strings. Before this signal, a scroll that loaded a thousand comments reported "no_change" and
  // told the caller nothing had loaded.
  const capped = "identical truncated markdown";
  assert.equal(selectVerdict("scroll", capped, capped, false, false, true), "dom_changed");
  assert.equal(selectVerdict("scroll", capped, capped, false, false, false), "no_change");
});

test("a navigation still outranks a content change", () => {
  assert.equal(selectVerdict("click", "before", "after", false, true, true), "navigated");
});

test("a successful fill still reports value_set when the page also grew", () => {
  assert.equal(selectVerdict("fill", "before", "after", true, false, true), "value_set");
});
