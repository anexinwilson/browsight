/**
 * The service worker: the bridge client and the policy enforcement point. It dials the local
 * server over a token-authenticated WebSocket, reconnects on wake, and routes read requests to the
 * active tab — but only after the deterministic permission gate allows it.
 */
import {
  type ActRequest,
  type BridgeMessage,
  BridgeMessageSchema,
  type Diff,
  type Ref,
  type Sentinel,
  type SentinelKind,
  type Verdict,
} from "@browsight/shared";
import { decideAccess } from "./permissions/policy.ts";
import { listGrants } from "./permissions/storage.ts";

interface Connection {
  readonly port: number;
  readonly token: string;
}

interface ContentReadResult {
  readonly markdown: string;
  readonly refs: Ref[];
  readonly hasPasswordField: boolean;
}

let socket: WebSocket | null = null;

async function loadConnection(): Promise<Connection | null> {
  try {
    const res = await fetch(chrome.runtime.getURL("connection.json"));
    const data = (await res.json()) as Partial<Connection>;
    if (typeof data.port === "number" && typeof data.token === "string") {
      return { port: data.port, token: data.token };
    }
  } catch {
    // Not set up yet — `npm run setup` writes connection.json.
  }
  return null;
}

async function connect(): Promise<void> {
  if (socket && socket.readyState <= WebSocket.OPEN) {
    return;
  }
  const conn = await loadConnection();
  if (!conn) {
    return;
  }
  const ws = new WebSocket(`ws://127.0.0.1:${conn.port}`);
  socket = ws;
  ws.addEventListener("open", () => {
    ws.send(
      JSON.stringify({
        type: "auth",
        token: conn.token,
        extensionVersion: chrome.runtime.getManifest().version,
      }),
    );
  });
  ws.addEventListener("message", (ev) => {
    void handleMessage(String(ev.data));
  });
  ws.addEventListener("close", () => {
    if (socket === ws) {
      socket = null;
    }
  });
  ws.addEventListener("error", () => {
    ws.close();
  });
}

async function handleMessage(raw: string): Promise<void> {
  let msg: BridgeMessage;
  try {
    msg = BridgeMessageSchema.parse(JSON.parse(raw));
  } catch {
    return;
  }
  if (msg.type === "read.request") {
    await handleRead(msg.id);
  } else if (msg.type === "act.request") {
    await handleAct(msg);
  }
}

async function handleRead(id: string): Promise<void> {
  const tab = await activeTab();
  if (!tab?.id || !tab.url) {
    sendSentinel(id, "frame_unreachable", "no active tab to read");
    return;
  }
  const origin = originOf(tab.url);
  const access = decideAccess(await listGrants(), origin, Date.now());
  if (!access.read) {
    sendSentinel(
      id,
      "not_whitelisted",
      `${origin} is not whitelisted — open the browsight popup and allow this site.`,
    );
    return;
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    const snap = (await chrome.tabs.sendMessage(tab.id, { kind: "read" })) as ContentReadResult;
    send({
      type: "read.response",
      id,
      markdown: snap.markdown,
      refs: snap.refs,
      hasPasswordField: snap.hasPasswordField,
    });
  } catch (err) {
    sendSentinel(id, "frame_unreachable", `could not read the page: ${String(err)}`);
  }
}

function send(msg: BridgeMessage): void {
  socket?.send(JSON.stringify(msg));
}

function sendSentinel(id: string, kind: SentinelKind, hint: string): void {
  send({
    type: "read.response",
    id,
    markdown: "",
    refs: [],
    hasPasswordField: false,
    sentinel: { kind, hint },
  });
}

interface ActContentResult {
  readonly verdict: Verdict;
  readonly diff: Diff;
  readonly refs: Ref[];
  readonly sentinel?: Sentinel;
}

async function handleAct(msg: ActRequest): Promise<void> {
  const tab = await activeTab();
  if (!tab?.id || !tab.url) {
    sendActSentinel(msg.id, "frame_unreachable", "no active tab to act on");
    return;
  }
  const grants = await listGrants();
  const now = Date.now();
  const origin = originOf(tab.url);
  if (!decideAccess(grants, origin, now).act) {
    sendActSentinel(
      msg.id,
      "not_whitelisted",
      `${origin} is not set to "Full control" — change its access in the browsight popup.`,
    );
    return;
  }

  if (msg.action === "navigate") {
    if (!msg.value) {
      sendActSentinel(msg.id, "not_actionable", "navigate needs a url value");
      return;
    }
    // Gate the destination too: a grant on one site must not let the agent send the tab to an
    // arbitrary origin. A navigation replaces the page via a top-level GET — that is an action, so
    // the destination needs full-control consent (.act), not merely read, or a read-only grant
    // could be driven to side-effecting URLs (/logout, ?action=delete) the user never consented to.
    const target = originOf(msg.value);
    if (!decideAccess(grants, target, now).act) {
      sendActSentinel(
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
      const moved = await activeTab();
      const newOrigin = moved?.url ? originOf(moved.url) : "";
      if (newOrigin && newOrigin !== origin && !decideAccess(grants, newOrigin, now).read) {
        sendActSentinel(
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
    sendActSentinel(msg.id, "frame_unreachable", `could not act on the page: ${message}`);
  }
}

function sendActSentinel(id: string, kind: SentinelKind, hint: string): void {
  send({
    type: "act.response",
    id,
    verdict: "no_change",
    diff: { appeared: [], removed: [], changed: [] },
    refs: [],
    sentinel: { kind, hint },
  });
}

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void connect();
});
chrome.runtime.onStartup.addListener(() => {
  void connect();
});
chrome.alarms.create("browsight-keepalive", { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(() => {
  void connect();
});
void connect();
