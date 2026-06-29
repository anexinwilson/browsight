/**
 * The read handler: snapshot the active tab as a semantic page, gated by the whitelist. Returns a
 * typed sentinel (not a thrown error or silent empty) when there is no tab, the site is not
 * whitelisted, or the page cannot be reached.
 */
import type { SentinelKind } from "@browsight/shared";
import { decideAccess } from "../permissions/policy.ts";
import { listGrants } from "../permissions/storage.ts";
import { type Send, activeTab, originOf, readTabContent } from "./common.ts";

export async function handleRead(send: Send, id: string): Promise<void> {
  const tab = await activeTab();
  if (!tab?.id || !tab.url) {
    sendSentinel(send, id, "frame_unreachable", "no active tab to read");
    return;
  }
  const origin = originOf(tab.url);
  if (!decideAccess(await listGrants(), origin, Date.now()).read) {
    sendSentinel(
      send,
      id,
      "not_whitelisted",
      `${origin} is not whitelisted — open the browsight popup and allow this site.`,
    );
    return;
  }
  try {
    const snap = await readTabContent(tab.id);
    send({
      type: "read.response",
      id,
      markdown: snap.markdown,
      refs: snap.refs,
      hasPasswordField: snap.hasPasswordField,
    });
  } catch (err) {
    sendSentinel(send, id, "frame_unreachable", `could not read the page: ${String(err)}`);
  }
}

function sendSentinel(send: Send, id: string, kind: SentinelKind, hint: string): void {
  send({
    type: "read.response",
    id,
    markdown: "",
    refs: [],
    hasPasswordField: false,
    sentinel: { kind, hint },
  });
}
