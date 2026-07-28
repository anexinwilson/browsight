import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const html = readFileSync(new URL("./options.html", import.meta.url), "utf8");
const dom = new JSDOM(html, { url: "chrome-extension://browsight/options.html" });
globalThis.window = dom.window as unknown as Window & typeof globalThis;
globalThis.document = dom.window.document;

let stored: unknown[] = [];
let allowRequest = true;
const removed: string[][] = [];
globalThis.chrome = {
  storage: {
    local: {
      async get() {
        return { "browsight.grants": stored };
      },
      async set(values: Record<string, unknown>) {
        stored = values["browsight.grants"] as unknown[];
      },
    },
  },
  permissions: {
    async request() {
      return allowRequest;
    },
    async remove(details: chrome.permissions.Permissions) {
      removed.push(details.origins ?? []);
      return true;
    },
  },
} as typeof chrome;

await import("./options.ts");

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

test("options page adds, rejects, lists, and removes site grants", async () => {
  const timer = document.getElementById("timer") as HTMLSelectElement;
  const origin = document.getElementById("origin") as HTMLInputElement;
  const add = document.getElementById("add") as HTMLButtonElement;
  assert.equal(timer.options.length, 6);

  origin.value = "not a URL";
  add.click();
  assert.match(document.getElementById("status")?.textContent ?? "", /full URL/);

  origin.value = "https://docs.example/path";
  add.click();
  await settle();
  assert.match(document.getElementById("rows")?.textContent ?? "", /docs\.example/);
  assert.equal(origin.value, "");

  allowRequest = false;
  origin.value = "https://denied.example";
  add.click();
  await settle();
  assert.match(document.getElementById("status")?.textContent ?? "", /declined/);

  const remove = document.querySelector<HTMLButtonElement>("#rows button");
  assert.ok(remove);
  remove.click();
  await settle();
  assert.equal(document.querySelector("#rows button"), null);
  assert.deepEqual(removed, [["https://docs.example/*"]]);
});
