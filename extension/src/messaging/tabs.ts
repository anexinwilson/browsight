/**
 * The tabs handler: list the open http(s) tabs and, when `select` resolves to a single whitelisted
 * tab, switch to it and read it. Every tab is listed (so a not-whitelisted tab can be named and the
 * user told to allow it), but switching/reading is gated on the same whitelist as everything else —
 * the agent can only move among sites the user has permitted.
 */
import type { Sentinel, TabInfo, TabsRequest } from "@browsight/shared";
import { decideAccess } from "../permissions/policy.ts";
import { listGrants } from "../permissions/storage.ts";
import { type Send, currentTab, originOf, readTabContent, setCurrentTab } from "./common.ts";
import { accessLabel, resolveTabSelection } from "./tab-select.ts";

export async function handleTabs(send: Send, msg: TabsRequest): Promise<void> {
  const grants = await listGrants();
  const now = Date.now();
  const all = await chrome.tabs.query({});
  const active = await currentTab();
  const infos: TabInfo[] = [];
  for (const t of all) {
    if (typeof t.id !== "number" || !t.url || !/^https?:/.test(t.url)) {
      continue;
    }
    const origin = originOf(t.url);
    infos.push({
      id: t.id,
      title: t.title ?? "",
      origin,
      active: t.id === active?.id,
      access: accessLabel(decideAccess(grants, origin, now)),
    });
  }

  if (!msg.select) {
    sendTabs(send, msg.id, infos);
    return;
  }

  // The whitelist gate for switching lives in this pure decision (unit-tested in tab-select.test.ts):
  // it only ever returns a "switch" for a single, whitelisted tab.
  const resolution = resolveTabSelection(
    infos.map((i) => ({ id: i.id, title: i.title, origin: i.origin })),
    grants,
    msg.select,
    now,
  );
  if (resolution.kind === "sentinel") {
    sendTabs(send, msg.id, infos, resolution.sentinel);
    return;
  }
  const target = resolution.tab;

  try {
    const win = all.find((t) => t.id === target.id)?.windowId;
    await chrome.tabs.update(target.id, { active: true });
    if (typeof win === "number") {
      await chrome.windows.update(win, { focused: true });
    }
    // Record the switch so subsequent read/act target this tab regardless of which window has focus.
    await setCurrentTab(target.id);
    const snap = await readTabContent(target.id);
    send({
      type: "tabs.response",
      id: msg.id,
      tabs: infos.map((i) => ({ ...i, active: i.id === target.id })),
      switchedTo: target.title || target.origin,
      markdown: snap.markdown,
      refs: snap.refs,
      hasPasswordField: snap.hasPasswordField,
    });
  } catch (err) {
    sendTabs(send, msg.id, infos, {
      kind: "frame_unreachable",
      hint: `switched to "${target.title}" but could not read it: ${String(err)}`,
    });
  }
}

function sendTabs(send: Send, id: string, tabs: TabInfo[], sentinel?: Sentinel): void {
  send({
    type: "tabs.response",
    id,
    tabs,
    refs: [],
    hasPasswordField: false,
    ...(sentinel ? { sentinel } : {}),
  });
}
