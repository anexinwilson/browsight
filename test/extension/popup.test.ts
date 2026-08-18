import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const html = readFileSync(join(import.meta.dirname, "../../extension/src/popup.html"), "utf8");
const dom = new JSDOM(html, { url: "chrome-extension://browsight/popup.html" });
globalThis.window = dom.window as unknown as Window & typeof globalThis;
globalThis.document = dom.window.document;

let stored: unknown[] = [];
const removed: string[][] = [];
globalThis.chrome = {
  tabs: {
    async query() {
      return [{ id: 5, url: "https://news.example/article", active: true } as chrome.tabs.Tab];
    },
  },
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
      return true;
    },
    async remove(details: chrome.permissions.Permissions) {
      removed.push(details.origins ?? []);
      return true;
    },
  },
} as unknown as typeof chrome;

await import("../../extension/src/popup.ts");

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

test("popup grants the selected tier and removes it again", async () => {
  assert.equal(document.getElementById("origin")?.textContent, "https://news.example");
  assert.equal((document.getElementById("timer") as HTMLSelectElement).options.length, 6);
  assert.match(document.getElementById("list")?.textContent ?? "", /none yet/);

  document.querySelector<HTMLButtonElement>('[data-tier="read"]')?.click();
  document.getElementById("grant")?.click();
  await settle();
  assert.match(document.getElementById("list")?.textContent ?? "", /news\.example/);
  assert.match(document.getElementById("list")?.textContent ?? "", /read/);

  const remove = document.querySelector<HTMLElement>("#list .x");
  assert.ok(remove);
  remove.click();
  await settle();
  assert.match(document.getElementById("list")?.textContent ?? "", /none yet/);
  assert.deepEqual(removed, [["https://news.example/*"]]);
});
