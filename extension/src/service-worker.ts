/**
 * The service worker: the bridge client and message router. It dials the local server over a
 * token-authenticated WebSocket, reconnects on wake, and dispatches each request to its handler in
 * ./messaging. The deterministic permission gate is enforced inside those handlers, not here.
 */
import { type BridgeMessage, BridgeMessageSchema } from "@browsight/shared";
import { handleAct } from "./messaging/act.ts";
import { handleRead } from "./messaging/read.ts";
import { handleTabs } from "./messaging/tabs.ts";

interface Connection {
  readonly port: number;
  readonly token: string;
  readonly host: string;
}

// Loopback-only allowlist — this extension is a local bridge and must never connect to remote hosts.
const ALLOWED_WS_HOSTS = ["127.0.0.1", "localhost"] as const;
type AllowedWsHost = (typeof ALLOWED_WS_HOSTS)[number];

let socket: WebSocket | null = null;

function send(msg: BridgeMessage): void {
  socket?.send(JSON.stringify(msg));
}

async function loadConnection(): Promise<Connection | null> {
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

async function connect(): Promise<void> {
  if (socket && socket.readyState <= WebSocket.OPEN) {
    return;
  }
  const conn = await loadConnection();
  if (!conn) {
    return;
  }
  // Guard: strictly map to allowlisted literal — user-supplied conn.host never touches WebSocket (S8480)
  const safeHost = ALLOWED_WS_HOSTS.find((h) => h === conn.host);
  if (!safeHost) {
    return;
  }
  // Guard: parse port to a validated integer so user-supplied JSON data never enters the URL directly (S8480)
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
  });
  // deepcode ignore Insufficient postMessage Validation: this is a WebSocket, not window.postMessage
  ws.addEventListener("message", (ev) => {
    const expectedOrigin = `ws://${safeHost}:${safePort}`;
    if (ev.origin === expectedOrigin) {
      void route(String(ev.data));
    } else {
      return;
    }
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

/** Parse one bridge frame and dispatch it to the handler for its request type. */
async function route(raw: string): Promise<void> {
  let msg: BridgeMessage;
  try {
    msg = BridgeMessageSchema.parse(JSON.parse(raw));
  } catch {
    return;
  }
  if (msg.type === "read.request") {
    await handleRead(send, msg.id);
  } else if (msg.type === "act.request") {
    await handleAct(send, msg);
  } else if (msg.type === "tabs.request") {
    await handleTabs(send, msg);
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
await connect();
