/**
 * The act handler: perform one action on the active tab, gated by the whitelist at full-control
 * tier. Navigation is special-cased (the destination origin is gated too); every other action is
 * delegated to the content script. A navigation that tears down the content script mid-act is
 * reported as a clean `navigated` verdict rather than a raw channel-closed error.
 */
import type { ActRequest, Diff, Ref, Sentinel, SentinelKind, Verdict } from "@browsight/shared";
import { decideAccess } from "../permissions/policy.ts";
import { listGrants } from "../permissions/storage.ts";
import { type Send, currentTab, originOf } from "./common.ts";

interface ActContentResult {
  readonly verdict: Verdict;
  readonly diff: Diff;
  readonly refs: Ref[];
  readonly sentinel?: Sentinel;
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
      `${origin} is not set to "Full control" — change its access in the browsight popup.`,
    );
    return;
  }

  if (msg.action === "navigate") {
    // `navigate` with value "reload" refreshes the current page in place. A reload stays on the same
    // origin, which the full-control check above already covered — so no destination gate is needed.
    // Useful when a page is stuck mid-render or a lazy region won't settle.
    if (msg.value === "reload" || msg.value === "refresh") {
      await chrome.tabs.reload(tab.id);
      send({
        type: "act.response",
        id: msg.id,
        verdict: "navigated",
        diff: { appeared: [], removed: [], changed: [] },
        refs: [],
      });
      return;
    }
    if (!msg.value) {
      sendActSentinel(send, msg.id, "not_actionable", "navigate needs a url value (or 'reload')");
      return;
    }
    // Gate the destination too: a grant on one site must not let the agent send the tab to an
    // arbitrary origin. A navigation replaces the page via a top-level GET — that is an action, so
    // the destination needs full-control consent (.act), not merely read, or a read-only grant
    // could be driven to side-effecting URLs (/logout, ?action=delete) the user never consented to.
    const target = originOf(msg.value);
    if (!decideAccess(grants, target, now).act) {
      sendActSentinel(
        send,
        msg.id,
        "not_whitelisted",
        `${target} is not set to "Full control" — navigating there is an action and needs full-control access in the browsight popup.`,
      );
      return;
    }
    await chrome.tabs.update(tab.id, { url: msg.value });
    send({
      type: "act.response",
      id: msg.id,
      verdict: "navigated",
      diff: { appeared: [], removed: [], changed: [] },
      refs: [],
    });
    return;
  }

  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    const result = (await chrome.tabs.sendMessage(tab.id, {
      kind: "act",
      ref: msg.ref,
      action: msg.action,
      value: msg.value,
    })) as ActContentResult;
    send({
      type: "act.response",
      id: msg.id,
      verdict: result.verdict,
      diff: result.diff,
      refs: result.refs,
      ...(result.sentinel ? { sentinel: result.sentinel } : {}),
    });
  } catch (err) {
    const message = String(err);
    // A click or submit that navigates tears down the content script before it can reply, so the
    // message channel closes. Report that as a clean "navigated" result instead of a raw error —
    // the next browser_read will see the new page.
    const navigatedAway =
      /back\/forward cache|message channel closed|message port closed|Receiving end does not exist/i;
    if (navigatedAway.test(message)) {
      // If the click drove the tab to an origin the user hasn't whitelisted, say so — a link click
      // must not quietly move the agent somewhere it has no grant for.
      const moved = await currentTab();
      const newOrigin = moved?.url ? originOf(moved.url) : "";
      if (newOrigin && newOrigin !== origin && !decideAccess(grants, newOrigin, now).read) {
        sendActSentinel(
          send,
          msg.id,
          "not_whitelisted",
          `the page navigated to ${newOrigin}, which is not whitelisted — allow it in the browsight popup to continue.`,
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
      return;
    }
    sendActSentinel(send, msg.id, "frame_unreachable", `could not act on the page: ${message}`);
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
