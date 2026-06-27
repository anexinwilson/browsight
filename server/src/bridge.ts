/**
 * The loopback bridge: a token-authenticated WebSocket server the extension dials into.
 *
 * The server listens; the extension connects (a service worker can open an outbound socket but
 * cannot host one). Requests are correlated to their responses by `id`. Bound to 127.0.0.1 only;
 * the first frame must be a matching auth token or the socket is dropped.
 */
import { randomUUID, timingSafeEqual } from "node:crypto";
import { type BridgeMessage, BridgeMessageSchema, type ReadResponse } from "@browsight/shared";
import { type WebSocket, WebSocketServer } from "ws";

const REQUEST_TIMEOUT_MS = 30_000;
const AUTH_TIMEOUT_MS = 2_000;
const MAX_PAYLOAD = 32 * 1024 * 1024;

interface Pending {
  readonly resolve: (msg: BridgeMessage) => void;
  readonly reject: (err: Error) => void;
  readonly timer: NodeJS.Timeout;
}

export interface Bridge {
  /** Ask the extension to read the active tab, optionally navigating to `url` first. */
  readActiveTab(url: string | null): Promise<ReadResponse>;
  close(): Promise<void>;
}

/** Start the bridge server bound to loopback and return a small request API. */
export function startBridge(opts: { readonly port: number; readonly token: string }): Bridge {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: opts.port, maxPayload: MAX_PAYLOAD });
  const pending = new Map<string, Pending>();
  let active: WebSocket | null = null;

  wss.on("connection", (ws) => {
    let authed = false;
    const authTimer = setTimeout(() => {
      if (!authed) {
        ws.close(1008, "auth timeout");
      }
    }, AUTH_TIMEOUT_MS);

    ws.on("message", (data) => {
      let msg: BridgeMessage;
      try {
        msg = BridgeMessageSchema.parse(JSON.parse(data.toString()));
      } catch {
        return;
      }

      if (!authed) {
        if (msg.type === "auth" && tokensMatch(msg.token, opts.token)) {
          authed = true;
          active = ws;
          clearTimeout(authTimer);
        } else {
          ws.close(1008, "unauthorized");
        }
        return;
      }

      if (msg.type === "read.response" || msg.type === "act.response") {
        const p = pending.get(msg.id);
        if (p) {
          clearTimeout(p.timer);
          pending.delete(msg.id);
          p.resolve(msg);
        }
      }
    });

    ws.on("close", () => {
      if (active === ws) {
        active = null;
      }
    });
  });

  function request(message: BridgeMessage, id: string): Promise<BridgeMessage> {
    return new Promise((resolve, reject) => {
      if (!active) {
        reject(new Error("the browsight extension is not connected — load it in Chrome"));
        return;
      }
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("timed out waiting for the extension"));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      active.send(JSON.stringify(message));
    });
  }

  return {
    async readActiveTab(url) {
      const id = randomUUID();
      const res = await request({ type: "read.request", id, url, schema: null }, id);
      return res as ReadResponse;
    },
    close() {
      return new Promise((resolve) => {
        wss.close(() => resolve());
      });
    },
  };
}

function tokensMatch(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
