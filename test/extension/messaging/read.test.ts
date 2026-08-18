import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { BridgeMessage } from "@browsight/shared";
import type { Grant } from "../../../extension/src/permissions/policy.ts";

let activeTab: chrome.tabs.Tab | undefined;
let currentTabId: number | undefined;
let grants: Grant[] = [];
let readError: Error | null = null;
const injected: number[] = [];
const contentMessages: unknown[] = [];

globalThis.chrome = {
  storage: {
    session: {
      async get() {
        return { "browsight.currentTab": currentTabId };
      },
      async set(values: Record<string, unknown>) {
        currentTabId = values["browsight.currentTab"] as number;
      },
    },
    local: {
      async get() {
        return { "browsight.grants": grants };
      },
      async set(values: Record<string, unknown>) {
        grants = values["browsight.grants"] as Grant[];
      },
    },
  },
  tabs: {
    async query() {
      return activeTab ? [activeTab] : [];
    },
    async get(id: number) {
      if (activeTab?.id === id) {
        return activeTab;
      }
      throw new Error("tab closed");
    },
    async sendMessage(_tabId: number, message: unknown) {
      contentMessages.push(message);
      if (readError) {
        throw readError;
      }
      return { markdown: "Page body", refs: [], hasPasswordField: false };
    },
  },
  scripting: {
    async executeScript(details: chrome.scripting.ScriptInjection<unknown[], unknown>) {
      injected.push(details.target.tabId);
      return [];
    },
  },
  permissions: {
    async remove() {
      return true;
    },
  },
} as unknown as typeof chrome;

const { handleRead } = await import("../../../extension/src/messaging/read.ts");

beforeEach(() => {
  activeTab = undefined;
  currentTabId = undefined;
  grants = [];
  readError = null;
  injected.length = 0;
  contentMessages.length = 0;
});

async function read(): Promise<BridgeMessage> {
  const sent: BridgeMessage[] = [];
  await handleRead((message) => sent.push(message), "read-1");
  assert.equal(sent.length, 1);
  return sent[0];
}

test("read returns a typed failure when no page is active", async () => {
  const result = await read();
  assert.equal(result.type, "read.response");
  assert.equal(
    result.type === "read.response" ? result.sentinel?.kind : undefined,
    "frame_unreachable",
  );
});

test("read refuses an origin that has not been allowed", async () => {
  activeTab = { id: 4, url: "https://denied.example/page" } as chrome.tabs.Tab;
  const result = await read();
  assert.equal(result.type, "read.response");
  assert.equal(
    result.type === "read.response" ? result.sentinel?.kind : undefined,
    "not_whitelisted",
  );
  assert.equal(currentTabId, 4);
  assert.deepEqual(injected, []);
});

test("read injects the content script and returns a semantic snapshot", async () => {
  activeTab = { id: 7, url: "https://allowed.example/page" } as chrome.tabs.Tab;
  grants = [{ origin: "https://allowed.example", tier: "read", expiresAt: null }];
  const result = await read();
  assert.equal(result.type, "read.response");
  assert.equal(result.type === "read.response" ? result.markdown : "", "Page body");
  assert.deepEqual(injected, [7]);
  assert.deepEqual(contentMessages, [{ kind: "read", mode: "full" }]);
});

test("read forwards main mode to the content script", async () => {
  activeTab = { id: 9, url: "https://allowed.example/inbox" } as chrome.tabs.Tab;
  grants = [{ origin: "https://allowed.example", tier: "read", expiresAt: null }];
  const sent: BridgeMessage[] = [];

  await handleRead((message) => sent.push(message), "read-main", "main");

  assert.equal(sent[0]?.type, "read.response");
  assert.deepEqual(contentMessages, [{ kind: "read", mode: "main" }]);
});

test("read converts content-script failures into a typed response", async () => {
  activeTab = { id: 8, url: "https://allowed.example/page" } as chrome.tabs.Tab;
  grants = [{ origin: "https://allowed.example", tier: "full", expiresAt: null }];
  readError = new Error("frame was replaced");
  const result = await read();
  assert.equal(result.type, "read.response");
  assert.equal(
    result.type === "read.response" ? result.sentinel?.kind : undefined,
    "frame_unreachable",
  );
  assert.match(
    result.type === "read.response" ? (result.sentinel?.hint ?? "") : "",
    /frame was replaced/,
  );
});
