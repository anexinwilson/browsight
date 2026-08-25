/**
 * The content script: the only code that touches the page. Injected on demand by the service
 * worker, it answers `read` (snapshot) and `act` messages. Injection can happen more than once, so
 * listeners are registered only on the first run.
 *
 * The page work is reached through an injected `PageTools` rather than imported directly, so tests
 * can drive the message handling with fakes without the shipped extension carrying test hooks.
 */
import type { Diff } from "@browsight/shared";
import { performAct, performBatchFill } from "./acting/act.ts";
import { rememberSnapshot } from "./acting/resolve.ts";
import type {
  ContentActResult,
  ContentMessage,
  ContentReadResult,
} from "./messaging/content-protocol.ts";
import { buildSnapshot, type SnapshotResult } from "./perception/snapshot.ts";

/** The page operations the message handler needs. Real ones in production, fakes under test. */
export interface PageTools {
  readonly buildSnapshot: typeof buildSnapshot;
  readonly rememberSnapshot: typeof rememberSnapshot;
  readonly performAct: typeof performAct;
  readonly performBatchFill: typeof performBatchFill;
}

const REAL_TOOLS: PageTools = { buildSnapshot, rememberSnapshot, performAct, performBatchFill };

const EMPTY_DIFF: Diff = { appeared: [], removed: [], changed: [] };

/**
 * Record this read as the basis a following action is measured against, but only when it covers the
 * page. A query returns just the matching lines and a later window just part of the document, so
 * either would make the next action report everything it did not include as newly appeared. Those
 * reads still number their elements, so their references remain usable; they simply leave the last
 * complete read standing as the basis.
 */
function rememberBasis(tools: PageTools, snap: SnapshotResult, message: ContentMessage): void {
  const complete = (message.offset ?? 0) === 0 && !message.query;
  if (complete) {
    tools.rememberSnapshot(snap.refs, snap.markdown, snap.signature, message.mode ?? "full");
  }
}

declare global {
  var __browsightInjected: boolean | undefined;
}

/**
 * Answer one message from the service worker. Returns true when the response is sent
 * asynchronously, which is what `chrome.runtime.onMessage` uses to keep the channel open.
 */
export function handleContentMessage(
  message: ContentMessage,
  sendResponse: (response: ContentReadResult | ContentActResult) => void,
  tools: PageTools = REAL_TOOLS,
): boolean {
  if (message.kind === "read") {
    const snap = tools.buildSnapshot(document, {
      mode: message.mode ?? "full",
      offset: message.offset ?? 0,
      query: message.query ?? "",
    });
    rememberBasis(tools, snap, message);
    // Freshness marker: performance.timeOrigin is the page's load time, constant for one page
    // instance, and it changes on every reload/navigation. It reflects the PAGE load, not this
    // content script's re-injection (the same document keeps the same timeOrigin), so comparing
    // it across two reads tells the agent whether the page actually refreshed/navigated.
    const pageLoad = Math.round(performance.timeOrigin);
    sendResponse({
      markdown: `<!-- page-load:${pageLoad} (changes on reload/navigate) -->\n${snap.markdown}`,
      refs: snap.refs,
      hasPasswordField: snap.hasPasswordField,
      truncated: snap.truncated,
      nextOffset: snap.nextOffset,
    });
    return false;
  }

  // A batch fill carries its own targets, so it does not need the single `ref`.
  if (message.kind === "act" && message.fields && message.fields.length > 0) {
    tools
      .performBatchFill(message.fields)
      .then(sendResponse)
      .catch((error: unknown) => {
        sendResponse({
          verdict: "no_change",
          diff: EMPTY_DIFF,
          refs: [],
          sentinel: { kind: "frame_unreachable", hint: `batch fill failed: ${String(error)}` },
        });
      });
    return true;
  }

  const hasTarget = typeof message.ref === "string" && message.ref.length > 0;
  const isViewportScroll = message.action === "scroll" && typeof message.value === "string";
  if (message.kind === "act" && message.action && (hasTarget || isViewportScroll)) {
    tools
      .performAct(message.ref as string, message.action, message.value)
      .then(sendResponse)
      .catch((error: unknown) => {
        sendResponse({
          verdict: "no_change",
          diff: EMPTY_DIFF,
          refs: [],
          sentinel: { kind: "frame_unreachable", hint: `page action failed: ${String(error)}` },
        });
      });
    return true;
  }
  return false;
}

if (!globalThis.__browsightInjected) {
  globalThis.__browsightInjected = true;
  chrome.runtime.onMessage.addListener((message: ContentMessage, _sender, sendResponse) =>
    handleContentMessage(message, sendResponse),
  );
}
