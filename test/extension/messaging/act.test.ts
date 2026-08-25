import assert from "node:assert";
import test from "node:test";

// Mock globals first before importing act.ts
let mockTab: any = null;
let mockGrants: any[] = [];
let reloadCalledWith: number | null = null;
let updateCalledWith: { tabId: number; updateProperties: any } | null = null;
let executeScriptCalled = false;
let sendMessageMock: ((tabId: number, message: any) => Promise<any>) | null = null;

const chromeMock: any = {
  storage: {
    session: {
      get: async (_key: string) => ({}),
      set: async (_data: any) => {},
    },
    local: {
      get: async (_key: string) => ({ "browsight.grants": mockGrants }),
      set: async (_data: any) => {},
    },
  },
  tabs: {
    reload: async (tabId: number) => {
      reloadCalledWith = tabId;
    },
    update: async (tabId: number, updateProperties: any) => {
      updateCalledWith = { tabId, updateProperties };
      if (mockTab && mockTab.id === tabId) {
        mockTab.url = updateProperties.url;
      }
      return mockTab;
    },
    query: async (_queryInfo: any) => {
      return mockTab ? [mockTab] : [];
    },
    get: async (tabId: number) => {
      if (mockTab && mockTab.id === tabId) return mockTab;
      throw new Error("Tab not found");
    },
    sendMessage: async (tabId: number, message: any) => {
      if (sendMessageMock) {
        return sendMessageMock(tabId, message);
      }
      return {};
    },
  },
  scripting: {
    executeScript: async (_info: any) => {
      executeScriptCalled = true;
      return [];
    },
  },
  permissions: {
    remove: async () => true,
  },
};

(globalThis as any).chrome = chromeMock;

// Import target handleAct
import { handleAct } from "../../../extension/src/messaging/act.ts";
import { ActionTimeoutError } from "../../../extension/src/messaging/deadline.ts";

function createSend() {
  const sent: any[] = [];
  const send = (msg: any) => {
    sent.push(msg);
  };
  return { send, sent };
}

test("Tab is null/undefined sends frame_unreachable sentinel", async () => {
  mockTab = null;
  mockGrants = [];
  const { send, sent } = createSend();
  await handleAct(send, {
    type: "act.request",
    id: "req1",
    action: "click",
    ref: "1",
  });
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].type, "act.response");
  assert.strictEqual(sent[0].verdict, "no_change");
  assert.strictEqual(sent[0].sentinel?.kind, "frame_unreachable");
});

test("Origin not whitelisted sends not_whitelisted sentinel", async () => {
  mockTab = { id: 1, url: "https://untrusted.com" };
  mockGrants = []; // no grants
  const { send, sent } = createSend();
  await handleAct(send, {
    type: "act.request",
    id: "req2",
    action: "click",
    ref: "1",
  });
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].sentinel?.kind, "not_whitelisted");
});

test("Navigate action: reload case", async () => {
  mockTab = { id: 10, url: "https://trusted.com" };
  mockGrants = [{ origin: "https://trusted.com", tier: "full", expiresAt: null }];
  reloadCalledWith = null;
  const { send, sent } = createSend();
  await handleAct(send, {
    type: "act.request",
    id: "req3",
    action: "navigate",
    value: "reload",
    ref: "",
  });
  assert.strictEqual(reloadCalledWith, 10);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].verdict, "navigated");
});

test("Navigate action: missing url case", async () => {
  mockTab = { id: 10, url: "https://trusted.com" };
  mockGrants = [{ origin: "https://trusted.com", tier: "full", expiresAt: null }];
  const { send, sent } = createSend();
  await handleAct(send, {
    type: "act.request",
    id: "req4",
    action: "navigate",
    value: undefined,
    ref: "",
  });
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].sentinel?.kind, "not_actionable");
});

test("Navigate action: unwhitelisted destination case", async () => {
  mockTab = { id: 10, url: "https://trusted.com" };
  mockGrants = [{ origin: "https://trusted.com", tier: "full", expiresAt: null }];
  const { send, sent } = createSend();
  await handleAct(send, {
    type: "act.request",
    id: "req5",
    action: "navigate",
    value: "https://untrusted.com",
    ref: "",
  });
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].sentinel?.kind, "not_whitelisted");
});

test("Navigate action: whitelisted destination case", async () => {
  mockTab = { id: 10, url: "https://trusted.com" };
  mockGrants = [
    { origin: "https://trusted.com", tier: "full", expiresAt: null },
    { origin: "https://other-trusted.com", tier: "full", expiresAt: null },
  ];
  updateCalledWith = null;
  const { send, sent } = createSend();
  await handleAct(send, {
    type: "act.request",
    id: "req6",
    action: "navigate",
    value: "https://other-trusted.com/page",
    ref: "",
  });
  assert.deepEqual(updateCalledWith, {
    tabId: 10,
    updateProperties: { url: "https://other-trusted.com/page" },
  });
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].verdict, "navigated");
});

test("Navigate action: failures return a typed response", async () => {
  mockTab = { id: 10, url: "https://trusted.com" };
  mockGrants = [{ origin: "https://trusted.com", tier: "full", expiresAt: null }];
  chromeMock.tabs.update = async () => {
    throw new Error("navigation blocked");
  };
  const { send, sent } = createSend();
  try {
    await handleAct(send, {
      type: "act.request",
      id: "navigate-failure",
      action: "navigate",
      value: "https://trusted.com/next",
      ref: "",
    });
  } finally {
    chromeMock.tabs.update = async (tabId: number, updateProperties: any) => {
      updateCalledWith = { tabId, updateProperties };
      if (mockTab && mockTab.id === tabId) {
        mockTab.url = updateProperties.url;
      }
      return mockTab;
    };
  }

  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].sentinel?.kind, "frame_unreachable");
  assert.match(sent[0].sentinel?.hint || "", /navigation blocked/);
});

test("Non-navigation actions use the already injected content script", async () => {
  mockTab = { id: 10, url: "https://trusted.com" };
  mockGrants = [{ origin: "https://trusted.com", tier: "full", expiresAt: null }];
  executeScriptCalled = false;
  sendMessageMock = async (tabId, message) => {
    assert.strictEqual(tabId, 10);
    assert.deepEqual(message, { kind: "act", ref: "btn1", action: "click", value: "some-val" });
    return {
      verdict: "dom_changed",
      diff: { appeared: ["link"], removed: [], changed: [] },
      refs: [{ id: 2, role: "link", name: "Next" }],
    };
  };

  const { send, sent } = createSend();
  await handleAct(send, {
    type: "act.request",
    id: "req7",
    action: "click",
    ref: "btn1",
    value: "some-val",
  });

  assert.strictEqual(executeScriptCalled, false);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].verdict, "dom_changed");
  assert.deepEqual(sent[0].diff.appeared, ["link"]);
  assert.strictEqual(sent[0].refs[0].name, "Next");
});

test("Non-navigation actions inject only when the content script is missing", async () => {
  mockTab = { id: 10, url: "https://trusted.com" };
  mockGrants = [{ origin: "https://trusted.com", tier: "full", expiresAt: null }];
  executeScriptCalled = false;
  let calls = 0;
  sendMessageMock = async () => {
    calls++;
    if (calls === 1) {
      throw new Error("Could not establish connection. Receiving end does not exist.");
    }
    return {
      verdict: "no_change",
      diff: { appeared: [], removed: [], changed: [] },
      refs: [],
    };
  };

  const { send, sent } = createSend();
  await handleAct(send, {
    type: "act.request",
    id: "req-inject-fallback",
    action: "click",
    ref: "btn1",
  });

  assert.strictEqual(executeScriptCalled, true);
  assert.strictEqual(calls, 2);
  assert.strictEqual(sent[0].verdict, "no_change");
});

test("sendMessage throws navigatedAway error, new tab is whitelisted", async () => {
  mockTab = { id: 10, url: "https://trusted.com" };
  mockGrants = [{ origin: "https://trusted.com", tier: "full", expiresAt: null }];
  sendMessageMock = async () => {
    throw new Error("message channel closed");
  };
  const { send, sent } = createSend();
  await handleAct(send, {
    type: "act.request",
    id: "req8a",
    action: "click",
    ref: "btn1",
  });
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].verdict, "navigated");
});

test("sendMessage throws navigatedAway error, new tab is NOT whitelisted", async () => {
  mockTab = { id: 10, url: "https://trusted.com" };
  mockGrants = [{ origin: "https://trusted.com", tier: "full", expiresAt: null }];
  sendMessageMock = async () => {
    mockTab = { id: 10, url: "https://untrusted.com" };
    throw new Error("message channel closed");
  };
  const { send, sent } = createSend();
  await handleAct(send, {
    type: "act.request",
    id: "req8b",
    action: "click",
    ref: "btn1",
  });
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].sentinel?.kind, "not_whitelisted");
  assert.match(sent[0].sentinel?.hint || "", /not whitelisted/);
});

test("a timed-out click is recovered when Chrome confirms the URL changed", async () => {
  mockTab = { id: 10, url: "https://trusted.com/before" };
  mockGrants = [{ origin: "https://trusted.com", tier: "full", expiresAt: null }];
  sendMessageMock = async () => {
    mockTab = { id: 10, url: "https://trusted.com/after", status: "complete" };
    throw new ActionTimeoutError("page action", 15_000);
  };
  const { send, sent } = createSend();

  await handleAct(send, {
    type: "act.request",
    id: "timeout-navigation",
    action: "click",
    ref: "btn1",
  });

  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].verdict, "navigated");
  assert.strictEqual(sent[0].sentinel, undefined);
});

test("a timed-out action remains a failure when the URL did not change", async () => {
  mockTab = { id: 10, url: "https://trusted.com/same", status: "complete" };
  mockGrants = [{ origin: "https://trusted.com", tier: "full", expiresAt: null }];
  sendMessageMock = async () => {
    throw new ActionTimeoutError("page action", 15_000);
  };
  const { send, sent } = createSend();

  await handleAct(send, {
    type: "act.request",
    id: "real-timeout",
    action: "click",
    ref: "btn1",
  });

  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].sentinel?.kind, "frame_unreachable");
  assert.match(sent[0].sentinel?.hint || "", /timed out/);
});

test("sendMessage throws a general error", async () => {
  mockTab = { id: 10, url: "https://trusted.com" };
  mockGrants = [{ origin: "https://trusted.com", tier: "full", expiresAt: null }];
  sendMessageMock = async () => {
    throw new Error("some random connection failure");
  };
  const { send, sent } = createSend();
  await handleAct(send, {
    type: "act.request",
    id: "req9",
    action: "click",
    ref: "btn1",
  });
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].sentinel?.kind, "frame_unreachable");
  assert.match(sent[0].sentinel?.hint || "", /could not act on the page/);
});

test("missing content-script responses are retried and returned as a typed failure", async () => {
  mockTab = { id: 10, url: "https://trusted.com" };
  mockGrants = [{ origin: "https://trusted.com", tier: "full", expiresAt: null }];
  let attempts = 0;
  sendMessageMock = async () => {
    attempts++;
    return undefined;
  };
  const { send, sent } = createSend();
  await handleAct(send, {
    type: "act.request",
    id: "missing-response",
    action: "scroll",
    ref: "",
    value: "down",
  });
  assert.strictEqual(attempts, 2);
  assert.strictEqual(sent[0].sentinel?.kind, "frame_unreachable");
  assert.match(sent[0].sentinel?.hint || "", /did not return an action result/);
});
