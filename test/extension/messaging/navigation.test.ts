import assert from "node:assert/strict";
import { mock, test } from "node:test";

interface TabStub {
  id: number;
  url: string;
  status: string;
}

let tab: TabStub = { id: 1, url: "https://site.example/a", status: "complete" };
const listeners = new Set<(id: number, info: { status?: string }, tab: TabStub) => void>();
let updateBehaviour: (url: string) => Promise<TabStub | undefined> = async (url) => {
  tab = { ...tab, url, status: "complete" };
  return tab;
};

(globalThis as unknown as { chrome: unknown }).chrome = {
  tabs: {
    get: async (id: number) => {
      if (tab.id === id) return tab;
      throw new Error("no tab");
    },
    update: async (_id: number, props: { url: string }) => updateBehaviour(props.url),
    reload: async () => undefined,
    onUpdated: {
      addListener: (fn: (id: number, info: { status?: string }, tab: TabStub) => void) => {
        listeners.add(fn);
      },
      removeListener: (fn: (id: number, info: { status?: string }, tab: TabStub) => void) => {
        listeners.delete(fn);
      },
    },
  },
};

const { handleNavigate } = await import("../../../extension/src/messaging/navigation.ts");

const grants = [{ origin: "https://site.example", tier: "full" as const, expiresAt: null }];

function collect() {
  const sent: unknown[] = [];
  return { sent, send: (msg: unknown) => sent.push(msg) };
}

test("a completed navigation reports navigated and leaves no listener behind", async () => {
  listeners.clear();
  updateBehaviour = async (url) => {
    tab = { id: 1, url, status: "complete" };
    return tab;
  };
  const { sent, send } = collect();

  await handleNavigate(send, "n1", "https://site.example/b", 1, grants, Date.now());

  assert.equal(listeners.size, 0);
  assert.equal((sent[0] as { verdict: string }).verdict, "navigated");
});

test("a navigation that never finishes loading does not leak its listener", async () => {
  // Regression: the listener was removed only when the promise settled, so hitting the deadline
  // left it registered for the life of the service worker. Repeated timeouts accumulated listeners,
  // each holding a closure over a promise nobody was waiting on.
  listeners.clear();
  updateBehaviour = async (url) => ({ id: 1, url, status: "loading" });
  tab = { id: 1, url: "https://site.example/slow", status: "loading" };

  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { send } = collect();
    const navigating = handleNavigate(
      send,
      "n2",
      "https://site.example/slow",
      1,
      grants,
      Date.now(),
    );
    const settled = navigating.then(
      () => "resolved",
      (err: unknown) => err,
    );
    // Let the listener register before the deadline fires.
    await Promise.resolve();
    assert.equal(listeners.size, 1, "the listener should be waiting at this point");

    mock.timers.tick(8_000);
    const outcome = await settled;

    assert.ok(outcome instanceof Error, "the stalled navigation must report a timeout");
    assert.equal(listeners.size, 0, "the listener must be removed when the deadline fires");
  } finally {
    mock.timers.reset();
  }
});

test("a navigation that fails to start removes its listener too", async () => {
  listeners.clear();
  updateBehaviour = async () => {
    throw new Error("tab is gone");
  };
  const { send } = collect();

  await assert.rejects(
    handleNavigate(send, "n3", "https://site.example/c", 1, grants, Date.now()),
    /tab is gone/,
  );
  assert.equal(listeners.size, 0);
});
