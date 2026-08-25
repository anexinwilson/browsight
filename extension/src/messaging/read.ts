/**
 * The read handler: snapshot the active tab as a semantic page, gated by the whitelist. Returns a
 * typed sentinel (not a thrown error or silent empty) when there is no tab, the site is not
 * whitelisted, or the page cannot be reached.
 */
import type { SentinelKind } from "@browsight/shared";
import { decideAccess } from "../permissions/policy.ts";
import { listGrants, touchGrant } from "../permissions/storage.ts";
import {
  currentTab,
  originOf,
  type ReadOptions,
  readTabContent,
  type Send,
  setCurrentTab,
} from "./common.ts";
import type { ContentReadResult } from "./content-protocol.ts";

/** No page, in the shape a read response expects. */
const EMPTY_READ: ContentReadResult = {
  markdown: "",
  refs: [],
  hasPasswordField: false,
  truncated: false,
  nextOffset: 0,
};

export async function handleRead(send: Send, id: string, options: ReadOptions): Promise<void> {
  // Operate on the tab the agent is driving (set by the last read or tab-switch), falling back to the
  // focused tab only when none is recorded yet. This makes read/act consistent and immune to OS focus
  // being on another window entirely (e.g. the service-worker devtools).
  const tab = await currentTab();
  if (!tab?.id || !tab.url) {
    sendSentinel(send, id, "frame_unreachable", "no tab to read, focus a page or use browser_tabs");
    return;
  }
  await setCurrentTab(tab.id);
  const origin = originOf(tab.url);
  if (!decideAccess(await listGrants(), origin, Date.now()).read) {
    sendSentinel(
      send,
      id,
      "not_whitelisted",
      `${origin} is not whitelisted, open the browsight popup and allow this site.`,
    );
    return;
  }
  await touchGrant(origin);
  try {
    const snap = await readTabContent(tab.id, options);
    // The content script already answers in the response's shape, so restating the fields here only
    // created a second place to forget one.
    send({ type: "read.response", id, ...snap });
  } catch (err) {
    sendSentinel(send, id, "frame_unreachable", `could not read the page: ${String(err)}`);
  }
}

/** A read that could not happen, reported as an empty page carrying the reason. */
function sendSentinel(send: Send, id: string, kind: SentinelKind, hint: string): void {
  send({ type: "read.response", id, ...EMPTY_READ, sentinel: { kind, hint } });
}
