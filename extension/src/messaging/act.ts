/**
 * The act handler: perform one action on the active tab, gated by the whitelist at full-control
 * tier. Navigation is special-cased (the destination origin is gated too); every other action is
 * delegated to the content script. A navigation that tears down the content script mid-act is
 * reported as a clean `navigated` verdict rather than a raw channel-closed error.
 */
import type { ActRequest, Diff, Ref, Sentinel, SentinelKind, Verdict } from "@browsight/shared";
import { decideAccess, type Grant } from "../permissions/policy.ts";
import { listGrants, touchGrant } from "../permissions/storage.ts";
import { currentTab, originOf, type Send } from "./common.ts";

interface ActContentResult {
  readonly verdict: Verdict;
  readonly diff: Diff;
  readonly refs: Ref[];
  readonly sentinel?: Sentinel;
}

const SCRIPT_INJECTION_TIMEOUT_MS = 3_000;
const CONTENT_ACTION_TIMEOUT_MS = 15_000;
const NAVIGATION_TIMEOUT_MS = 8_000;

export class ActionTimeoutError extends Error {
  readonly stage: string;
  readonly timeoutMs: number;

  constructor(stage: string, timeoutMs: number) {
    super(`${stage} timed out after ${timeoutMs} ms`);
    this.name = "ActionTimeoutError";
    this.stage = stage;
    this.timeoutMs = timeoutMs;
  }
}

export async function withDeadline<T>(
  promise: Promise<T>,
  stage: string,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ActionTimeoutError(stage, timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function isActContentResult(value: unknown): value is ActContentResult {
  if (!value || typeof value !== "object") {
    return false;
  }
  const result = value as Partial<ActContentResult>;
  return (
    typeof result.verdict === "string" &&
    typeof result.diff === "object" &&
    Array.isArray(result.refs)
  );
}

async function sendContentAct(tabId: number, msg: ActRequest): Promise<ActContentResult> {
  const actionMessage = {
    kind: "act",
    ref: msg.ref,
    action: msg.action,
    value: msg.value,
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      await withDeadline(
        chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] }),
        "content-script injection",
        SCRIPT_INJECTION_TIMEOUT_MS,
      );
    }
    let result: unknown;
    try {
      result = await withDeadline(
        chrome.tabs.sendMessage(tabId, actionMessage),
        "page action",
        CONTENT_ACTION_TIMEOUT_MS,
      );
    } catch (error: unknown) {
      if (
        attempt === 0 &&
        /Receiving end does not exist|Could not establish connection/i.test(String(error))
      ) {
        continue;
      }
      throw error;
    }
    if (isActContentResult(result)) {
      return result;
    }
  }
  throw new Error("the page content script did not return an action result");
}

function tabIsReady(tab: chrome.tabs.Tab | undefined): tab is chrome.tabs.Tab {
  return Boolean(tab && tab.status !== "loading");
}

async function waitForTabReady(
  tabId: number,
  start: () => Promise<chrome.tabs.Tab | undefined>,
): Promise<chrome.tabs.Tab> {
  const onUpdated = chrome.tabs.onUpdated;
  if (!onUpdated?.addListener || !onUpdated.removeListener) {
    await start();
    return chrome.tabs.get(tabId);
  }

  return withDeadline(
    new Promise<chrome.tabs.Tab>((resolve, reject) => {
      const finish = (tab: chrome.tabs.Tab): void => {
        onUpdated.removeListener(listener);
        resolve(tab);
      };
      const listener = (
        updatedTabId: number,
        changeInfo: chrome.tabs.OnUpdatedInfo,
        tab: chrome.tabs.Tab,
      ): void => {
        if (updatedTabId === tabId && (changeInfo.status === "complete" || tabIsReady(tab))) {
          finish(tab);
        }
      };
      onUpdated.addListener(listener);
      start()
        .then(async (tab) => {
          const observed = tab ?? (await chrome.tabs.get(tabId));
          if (tabIsReady(observed)) {
            finish(observed);
          }
        })
        .catch((error: unknown) => {
          onUpdated.removeListener(listener);
          reject(error);
        });
    }),
    "navigation",
    NAVIGATION_TIMEOUT_MS,
  );
}

async function waitForExistingNavigation(tabId: number): Promise<chrome.tabs.Tab> {
  return waitForTabReady(tabId, () => chrome.tabs.get(tabId));
}

async function handleNavigate(
  send: Send,
  id: string,
  value: string | undefined,
  tabId: number,
  grants: Grant[],
  now: number,
): Promise<void> {
  if (value === "reload" || value === "refresh") {
    await waitForTabReady(tabId, async () => {
      await chrome.tabs.reload(tabId);
      return undefined;
    });
    send({
      type: "act.response",
      id,
      verdict: "navigated",
      diff: { appeared: [], removed: [], changed: [] },
      refs: [],
    });
    return;
  }
  if (!value) {
    sendActSentinel(send, id, "not_actionable", "navigate needs a url value (or 'reload')");
    return;
  }
  const target = originOf(value);
  if (!decideAccess(grants, target, now).act) {
    sendActSentinel(
      send,
      id,
      "not_whitelisted",
      `${target} is not set to "Full control", navigating there is an action and needs full-control access in the browsight popup.`,
    );
    return;
  }
  const destination = await waitForTabReady(tabId, () => chrome.tabs.update(tabId, { url: value }));
  const destinationOrigin = destination.url ? originOf(destination.url) : target;
  if (!decideAccess(grants, destinationOrigin, Date.now()).read) {
    sendActSentinel(
      send,
      id,
      "not_whitelisted",
      `the page navigated to ${destinationOrigin}, which is not whitelisted, allow it in the browsight popup to continue.`,
    );
    return;
  }
  send({
    type: "act.response",
    id,
    verdict: "navigated",
    diff: { appeared: [], removed: [], changed: [] },
    refs: [],
  });
}

interface ContentActFailureContext {
  readonly send: Send;
  readonly msg: ActRequest;
  readonly tabId: number;
  readonly originalUrl: string;
  readonly origin: string;
  readonly grants: Grant[];
  readonly now: number;
}

async function handleContentActFailure(
  context: ContentActFailureContext,
  error: unknown,
): Promise<void> {
  const { send, msg, tabId, originalUrl, origin, grants, now } = context;
  if (error instanceof ActionTimeoutError) {
    const moved = await currentTab();
    if (!moved?.url || moved.url === originalUrl) {
      sendActSentinel(send, msg.id, "frame_unreachable", error.message);
      return;
    }
  }
  const message = String(error);
  const navigatedAway =
    /back\/forward cache|message channel closed|message port closed|Receiving end does not exist/i;
  if (!(error instanceof ActionTimeoutError) && !navigatedAway.test(message)) {
    sendActSentinel(send, msg.id, "frame_unreachable", `could not act on the page: ${message}`);
    return;
  }

  try {
    await waitForExistingNavigation(tabId);
  } catch (navigationError: unknown) {
    if (!(navigationError instanceof ActionTimeoutError)) {
      throw navigationError;
    }
    // A slow page is not a failed one. Sites that hold long-lived connections open
    // never settle the load event even though the document is rendered and readable,
    // so check the tab before calling it unreachable.
    const settled = await currentTab();
    if (settled?.status !== "complete") {
      sendActSentinel(
        send,
        msg.id,
        "frame_unreachable",
        `${navigationError.message}, the page may still be loading; call browser_read to see what rendered.`,
      );
      return;
    }
  }

  // A navigation must not silently move the agent onto an origin the user has not allowed.
  const moved = await currentTab();
  const newOrigin = moved?.url ? originOf(moved.url) : "";
  if (newOrigin && newOrigin !== origin && !decideAccess(grants, newOrigin, now).read) {
    sendActSentinel(
      send,
      msg.id,
      "not_whitelisted",
      `the page navigated to ${newOrigin}, which is not whitelisted, allow it in the browsight popup to continue.`,
    );
    return;
  }
  send({
    type: "act.response",
    id: msg.id,
    verdict: "navigated",
    diff: { appeared: [], removed: [], changed: [] },
    refs: [],
  });
}

export async function handleAct(send: Send, msg: ActRequest): Promise<void> {
  const tab = await currentTab();
  if (!tab?.id || !tab.url) {
    sendActSentinel(send, msg.id, "frame_unreachable", "no active tab to act on");
    return;
  }
  const grants = await listGrants();
  const now = Date.now();
  const origin = originOf(tab.url);
  if (!decideAccess(grants, origin, now).act) {
    sendActSentinel(
      send,
      msg.id,
      "not_whitelisted",
      `${origin} is not set to "Full control", change its access in the browsight popup.`,
    );
    return;
  }
  await touchGrant(origin);

  if (msg.action === "navigate") {
    try {
      await handleNavigate(send, msg.id, msg.value, tab.id, grants, now);
    } catch (error: unknown) {
      const hint =
        error instanceof ActionTimeoutError
          ? error.message
          : `could not navigate the page: ${String(error)}`;
      sendActSentinel(send, msg.id, "frame_unreachable", hint);
    }
    return;
  }

  try {
    const result = await sendContentAct(tab.id, msg);
    send({
      type: "act.response",
      id: msg.id,
      verdict: result.verdict,
      diff: result.diff,
      refs: result.refs,
      ...(result.sentinel ? { sentinel: result.sentinel } : {}),
    });
  } catch (error) {
    await handleContentActFailure(
      { send, msg, tabId: tab.id, originalUrl: tab.url, origin, grants, now },
      error,
    );
  }
}

function sendActSentinel(send: Send, id: string, kind: SentinelKind, hint: string): void {
  send({
    type: "act.response",
    id,
    verdict: "no_change",
    diff: { appeared: [], removed: [], changed: [] },
    refs: [],
    sentinel: { kind, hint },
  });
}
