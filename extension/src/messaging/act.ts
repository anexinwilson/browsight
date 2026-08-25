/**
 * The act handler: perform one action on the active tab, gated by the whitelist at full-control
 * tier. Navigation is special-cased (the destination origin is gated too); every other action is
 * delegated to the content script. A navigation that tears down the content script mid-act is
 * reported as a clean `navigated` verdict rather than a raw channel-closed error.
 */
import type { ActRequest } from "@browsight/shared";
import { decideAccess, type Grant } from "../permissions/policy.ts";
import { listGrants, touchGrant } from "../permissions/storage.ts";
import { currentTab, originOf, type Send } from "./common.ts";
import type { ContentActResult } from "./content-protocol.ts";
import { ActionTimeoutError, withDeadline } from "./deadline.ts";
import { handleNavigate, waitForExistingNavigation } from "./navigation.ts";
import { sendActSentinel } from "./sentinels.ts";

const SCRIPT_INJECTION_TIMEOUT_MS = 3_000;
const CONTENT_ACTION_TIMEOUT_MS = 15_000;

function isContentActResult(value: unknown): value is ContentActResult {
  if (!value || typeof value !== "object") {
    return false;
  }
  const result = value as Partial<ContentActResult>;
  return (
    typeof result.verdict === "string" &&
    typeof result.diff === "object" &&
    Array.isArray(result.refs)
  );
}

async function sendContentAct(tabId: number, msg: ActRequest): Promise<ContentActResult> {
  const actionMessage = {
    kind: "act",
    ref: msg.ref,
    action: msg.action,
    value: msg.value,
    ...(msg.fields ? { fields: msg.fields } : {}),
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
    if (isContentActResult(result)) {
      return result;
    }
  }
  throw new Error("the page content script did not return an action result");
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
