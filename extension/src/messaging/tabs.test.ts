import assert from "node:assert";
import test from "node:test";

let mockTabs: any[] = [];
let mockGrants: any[] = [];
let sessionStore: Record<string, any> = {};
let updateCalledWith: { tabId: number; updateProperties: any } | null = null;
let windowUpdateCalledWith: { windowId: number; updateProperties: any } | null = null;
let executeScriptCalled = false;
let sendMessageMock: ((tabId: number, message: any) => Promise<any>) | null = null;

const chromeMock: any = {
  storage: {
    session: {
      get: async (key: string) => sessionStore,
      set: async (data: any) => {
        sessionStore = { ...sessionStore, ...data };
      },
    },
    local: {
      get: async (key: string) => ({ "browsight.grants": mockGrants }),
      set: async (data: any) => {},
    },
  },
  tabs: {
    query: async (queryInfo: any) => {
      if (queryInfo.active && queryInfo.lastFocusedWindow) {
        const activeId = sessionStore["browsight.currentTab"];
        const found = mockTabs.find((t) => t.id === activeId);
        if (found) return [found];
        if (mockTabs.length > 0) return [mockTabs[0]];
        return [];
      }
      return mockTabs;
    },
    get: async (tabId: number) => {
      const found = mockTabs.find((t) => t.id === tabId);
      if (found) return found;
      throw new Error("Tab not found");
    },
    update: async (tabId: number, updateProperties: any) => {
      updateCalledWith = { tabId, updateProperties };
      const found = mockTabs.find((t) => t.id === tabId);
      if (found) {
        Object.assign(found, updateProperties);
        return found;
      }
      throw new Error("Tab not found");
    },
    sendMessage: async (tabId: number, message: any) => {
      if (sendMessageMock) {
        return sendMessageMock(tabId, message);
      }
      return {};
    },
  },
  windows: {
    update: async (windowId: number, updateProperties: any) => {
      windowUpdateCalledWith = { windowId, updateProperties };
      return {};
    },
  },
  scripting: {
    executeScript: async (info: any) => {
      executeScriptCalled = true;
      return [];
    },
  },
  permissions: {
    remove: async () => true,
  },
};

(globalThis as any).chrome = chromeMock;

// Import target handleTabs
import { handleTabs } from "./tabs.ts";

function createSend() {
  const sent: any[] = [];
  const send = (msg: any) => {
    sent.push(msg);
  };
  return { send, sent };
}

test("Listing tabs (when no select is provided) filters and resolves status/labels", async () => {
  mockTabs = [
    { id: 1, url: "https://trusted.com/page1", title: "Trusted Page", windowId: 10 },
    { id: 2, url: "http://another.com/page2", title: "HTTP Page", windowId: 10 },
    { id: 3, url: "chrome://extensions", title: "Extensions", windowId: 10 },
    { id: 4, url: undefined, title: "No URL", windowId: 10 },
  ];
  mockGrants = [
    { origin: "https://trusted.com", tier: "full", expiresAt: null },
    { origin: "http://another.com", tier: "read", expiresAt: null },
  ];
  sessionStore = { "browsight.currentTab": 1 };

  const { send, sent } = createSend();
  await handleTabs(send, {
    type: "tabs.request",
    id: "req1",
  });

  assert.strictEqual(sent.length, 1);
  const response = sent[0];
  assert.strictEqual(response.type, "tabs.response");
  assert.strictEqual(response.tabs.length, 2);

  const tab1 = response.tabs.find((t: any) => t.id === 1);
  assert.ok(tab1);
  assert.strictEqual(tab1.title, "Trusted Page");
  assert.strictEqual(tab1.origin, "https://trusted.com");
  assert.strictEqual(tab1.active, true);
  assert.strictEqual(tab1.access, "full");

  const tab2 = response.tabs.find((t: any) => t.id === 2);
  assert.ok(tab2);
  assert.strictEqual(tab2.title, "HTTP Page");
  assert.strictEqual(tab2.origin, "http://another.com");
  assert.strictEqual(tab2.active, false);
  assert.strictEqual(tab2.access, "read");
});

test("Selecting a tab: resolveTabSelection returns a sentinel", async () => {
  mockTabs = [
    { id: 1, url: "https://trusted.com", title: "Trusted Page", windowId: 10 },
    { id: 2, url: "https://untrusted.com", title: "Untrusted Page", windowId: 10 },
  ];
  mockGrants = [{ origin: "https://trusted.com", tier: "full", expiresAt: null }];
  sessionStore = { "browsight.currentTab": 1 };

  const { send, sent } = createSend();
  await handleTabs(send, {
    type: "tabs.request",
    id: "req2a",
    select: "untrusted",
  });

  assert.strictEqual(sent.length, 1);
  const response = sent[0];
  assert.strictEqual(response.sentinel?.kind, "not_whitelisted");
});

test("Selecting a tab: resolveTabSelection returns a valid tab and reads it", async () => {
  mockTabs = [
    { id: 1, url: "https://trusted.com", title: "Trusted Page", windowId: 10 },
    { id: 2, url: "https://trusted2.com", title: "Trusted Page 2", windowId: 10 },
  ];
  mockGrants = [
    { origin: "https://trusted.com", tier: "full", expiresAt: null },
    { origin: "https://trusted2.com", tier: "read", expiresAt: null },
  ];
  sessionStore = { "browsight.currentTab": 1 };
  updateCalledWith = null;
  windowUpdateCalledWith = null;
  executeScriptCalled = false;

  sendMessageMock = async (tabId, message) => {
    assert.strictEqual(tabId, 2);
    assert.strictEqual(message.kind, "read");
    return {
      markdown: "Page 2 content",
      refs: [{ id: 1, role: "link", name: "Back" }],
      hasPasswordField: false,
    };
  };

  const { send, sent } = createSend();
  await handleTabs(send, {
    type: "tabs.request",
    id: "req2b",
    select: "trusted2",
  });

  assert.deepEqual(updateCalledWith, { tabId: 2, updateProperties: { active: true } });
  assert.deepEqual(windowUpdateCalledWith, { windowId: 10, updateProperties: { focused: true } });
  assert.strictEqual(sessionStore["browsight.currentTab"], 2);
  assert.strictEqual(executeScriptCalled, true);

  assert.strictEqual(sent.length, 1);
  const response = sent[0];
  assert.strictEqual(response.switchedTo, "Trusted Page 2");
  assert.strictEqual(response.markdown, "Page 2 content");
  assert.strictEqual(response.refs[0].name, "Back");
});

test("Selecting a tab: resolution/readTabContent throws error", async () => {
  mockTabs = [
    { id: 1, url: "https://trusted.com", title: "Trusted Page", windowId: 10 },
    { id: 2, url: "https://trusted2.com", title: "Trusted Page 2", windowId: 10 },
  ];
  mockGrants = [
    { origin: "https://trusted.com", tier: "full", expiresAt: null },
    { origin: "https://trusted2.com", tier: "read", expiresAt: null },
  ];
  sessionStore = { "browsight.currentTab": 1 };

  sendMessageMock = async (tabId, message) => {
    throw new Error("Cannot message the tab context");
  };

  const { send, sent } = createSend();
  await handleTabs(send, {
    type: "tabs.request",
    id: "req2c",
    select: "trusted2",
  });

  assert.strictEqual(sent.length, 1);
  const response = sent[0];
  assert.strictEqual(response.sentinel?.kind, "frame_unreachable");
  assert.match(response.sentinel?.hint || "", /could not read it/);
});
