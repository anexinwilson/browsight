import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { settle } from "./settle.ts";

const dom = new JSDOM(
  '<!doctype html><html><body><main id="task"></main><aside id="noise"></aside></body></html>',
);
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  Node: dom.window.Node,
  MutationObserver: dom.window.MutationObserver,
});

test("settle can observe only the active semantic region", async () => {
  const task = document.querySelector("#task") as HTMLElement;
  const noise = document.querySelector("#noise") as HTMLElement;
  const result = settle(task, 300, 20, 5);

  const backgroundChurn = setInterval(() => {
    noise.setAttribute("data-tick", String(Date.now()));
  }, 1);
  setTimeout(() => {
    task.append("ready");
  }, 5);

  const winner = await Promise.race([
    result.then(() => "settled"),
    new Promise<"deadline">((resolve) => setTimeout(() => resolve("deadline"), 200)),
  ]);
  clearInterval(backgroundChurn);

  assert.equal(winner, "settled");
  assert.equal(task.textContent, "ready");
});

test("settle keeps a hard upper bound when the active region keeps changing", async () => {
  const task = document.querySelector("#task") as HTMLElement;
  const churn = setInterval(() => {
    task.append(".");
  }, 2);

  let settled = false;
  const result = settle(task, 40, 20, 5).then(() => {
    settled = true;
    return "settled" as const;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(settled, false);
  const winner = await Promise.race([
    result,
    new Promise<"deadline">((resolve) => setTimeout(() => resolve("deadline"), 150)),
  ]);
  clearInterval(churn);

  assert.equal(winner, "settled");
});
