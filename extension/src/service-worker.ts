/**
 * The service worker: the bridge client and the policy enforcement point. It dials the local
 * server over a token-authenticated WebSocket, reconnects on wake, and routes read requests to the
 * active tab — but only after the deterministic permission gate allows it.
 */
import {
  type BridgeMessage,
  BridgeMessageSchema,
  type Ref,
  type SentinelKind,
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
