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
import { listGrants } from "./permissions.ts";
import { decideAccess } from "./policy.ts";

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
    // arbitrary, un-whitelisted origin (e.g. a destructive GET endpoint or a hostile page).
    const target = originOf(msg.value);
    if (!decideAccess(grants, target, now).read) {
      sendActSentinel(
        msg.id,
        "not_whitelisted",
        `${target} is not whitelisted — allow it in the browsight popup before navigating there.`,
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
    sendActSentinel(msg.id, "frame_unreachable", `could not act on the page: ${String(err)}`);
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
