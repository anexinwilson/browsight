/**
 * The service worker: the bridge client and message router. It dials the local server over a
 * token-authenticated WebSocket, reconnects on wake, and dispatches each request to its handler in
 * ./messaging. The deterministic permission gate is enforced inside those handlers, not here.
 */
import { type BridgeMessage, BridgeMessageSchema } from "@browsight/shared";
import { handleAct } from "./messaging/act.ts";
import { handleRead } from "./messaging/read.ts";
import { handleTabs } from "./messaging/tabs.ts";
import { listGrants } from "./permissions/storage.ts";

interface Connection {
  readonly port: number;
  readonly token: string;
  readonly host: string;
}

// Loopback-only allowlist — this extension is a local bridge and must never connect to remote hosts.
const ALLOWED_WS_HOSTS = ["127.0.0.1", "localhost"] as const;
type AllowedWsHost = (typeof ALLOWED_WS_HOSTS)[number];

let socket: WebSocket | null = null;
let connectionAttempt: Promise<void> | null = null;
export function setSocket(s: WebSocket | null): void {
  socket = s;
}

function send(msg: BridgeMessage): void {
  socket?.send(JSON.stringify(msg));
}

async function reportAccessStatus(target: WebSocket | null = socket): Promise<void> {
  if (target?.readyState !== WebSocket.OPEN) {
    return;
  }
  const activeGrantCount = (await listGrants()).length;
  if (target === socket && target.readyState === WebSocket.OPEN) {
    target.send(JSON.stringify({ type: "access.status", activeGrantCount }));
  }
}

export async function loadConnection(): Promise<Connection | null> {
  try {
    const res = await fetch(chrome.runtime.getURL("connection.json"));
    const data = (await res.json()) as Partial<Connection>;
    if (typeof data.port === "number" && typeof data.token === "string") {
      return {
        port: data.port,
        token: data.token,
        host: typeof data.host === "string" ? data.host : "127.0.0.1",
      };
    }
  } catch {
    // Not set up yet — `npm run setup` writes connection.json.
  }
  return null;
}

async function openConnection(): Promise<void> {
  if (socket && socket.readyState <= WebSocket.OPEN) {
    return;
  }
  const conn = await loadConnection();
  if (!conn) {
    return;
  }
  // Map configuration to an allowlisted literal before constructing the socket URL.
  const safeHost = ALLOWED_WS_HOSTS.find((h) => h === conn.host);
  if (!safeHost) {
    return;
  }
  // Accept only a valid TCP port from the generated configuration.
  const safePort = Number.parseInt(String(conn.port), 10);
  if (Number.isNaN(safePort) || safePort < 1 || safePort > 65535) {
    return;
  }
  const ws = new WebSocket(`ws://${safeHost}:${safePort}`);
  socket = ws;
  ws.addEventListener("open", () => {
    ws.send(
      JSON.stringify({
        type: "auth",
        token: conn.token,
        extensionVersion: chrome.runtime.getManifest().version,
      }),
    );
    void reportAccessStatus(ws).catch(reportConnectionError);
  });
  // Use WebSocket's dedicated handler property so this cannot be mistaken for a window
  // `postMessage` listener; only frames from this authenticated loopback socket reach it.
  ws.onmessage = (ev) => {
    const expectedOrigin = `ws://${safeHost}:${safePort}`;
    if (ev.origin !== expectedOrigin) {
      return;
    }
    void route(String(ev.data));
  };
  ws.addEventListener("close", () => {
    if (socket === ws) {
      socket = null;
    }
  });
  ws.addEventListener("error", () => {
    ws.close();
  });
}

export async function connect(): Promise<void> {
  if (socket && socket.readyState <= WebSocket.OPEN) {
    return;
  }
  if (connectionAttempt) {
    return connectionAttempt;
  }
  connectionAttempt = openConnection();
  try {
    await connectionAttempt;
  } finally {
    connectionAttempt = null;
  }
}

/** Parse one bridge frame and dispatch it to the handler for its request type. */
export async function route(raw: string): Promise<void> {
  let msg: BridgeMessage;
  try {
    msg = BridgeMessageSchema.parse(JSON.parse(raw));
  } catch {
    return;
  }
  if (msg.type === "read.request") {
    await handleRead(send, msg.id, msg.mode);
  } else if (msg.type === "act.request") {
    await handleAct(send, msg);
  } else if (msg.type === "tabs.request") {
    await handleTabs(send, msg);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  requestConnection();
});
chrome.runtime.onStartup.addListener(() => {
  requestConnection();
});
chrome.alarms.create("browsight-keepalive", { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(() => {
  requestConnection();
  void reportAccessStatus().catch(reportConnectionError);
});

function reportConnectionError(error: unknown): void {
  console.error("browsight connection failed", error);
}

function requestConnection(): void {
  connect().catch(reportConnectionError);
}

// Extension service workers reject top-level await even when the manifest declares an ESM worker.
// Start asynchronously so registration can finish before the first bridge connection attempt.
requestConnection();
