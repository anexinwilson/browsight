/**
 * The loopback bridge: a token-authenticated WebSocket server the extension dials into.
 *
 * The server listens; the extension connects (a service worker can open an outbound socket but
 * cannot host one). Requests are correlated to their responses by `id`. Bound to 127.0.0.1 only;
 * the first frame must be a matching auth token or the socket is dropped.
 */
import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  type ActResponse,
  type Action,
  type BridgeMessage,
  BridgeMessageSchema,
  type ReadResponse,
  type TabsResponse,
} from "@browsight/shared";
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
  /** Ask the extension to perform one action on the active tab. */
  actActiveTab(req: { ref: string; action: Action; value?: string }): Promise<ActResponse>;
  /** List the open tabs, optionally switching to (and reading) the one matching `select`. */
  listTabs(select: string | null): Promise<TabsResponse>;
  close(): Promise<void>;
}

/** Start the bridge server bound to loopback and return a small request API. */
export function startBridge(opts: { readonly port: number; readonly token: string }): Bridge {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: opts.port, maxPayload: MAX_PAYLOAD });
  const pending = new Map<string, Pending>();
  let active: WebSocket | null = null;
  let listenError: string | null = null;

  // If the port is already taken — almost always a second browsight server launched by another MCP
  // client — the server emits 'error'. Handle it so the process degrades with a clear message instead
  // of crashing on an unhandled 'error' event. We deliberately do NOT rebind to a different port: the
  // extension dials one known port, so grabbing another would hijack it from the instance already
  // serving it. Stepping aside is the correct behaviour — only one client drives browsight at a time.
  wss.on("error", (err: Error) => {
    const code = (err as NodeJS.ErrnoException).code;
    listenError =
      code === "EADDRINUSE"
        ? `another browsight instance is already using 127.0.0.1:${opts.port} — only one client can drive browsight at a time; close it in the other client, or drive browsight from there.`
        : `the browsight bridge could not start: ${err.message}`;
    process.stderr.write(`browsight: ${listenError}\n`);
  });

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
        const text = Buffer.from(data as Buffer).toString("utf-8");
        msg = BridgeMessageSchema.parse(JSON.parse(text));
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
      // Already authenticated — fall through to response handling below.

      if (
        msg.type === "read.response" ||
        msg.type === "act.response" ||
        msg.type === "tabs.response"
      ) {
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
        // Fail any in-flight requests immediately rather than letting them wait out the full
        // timeout — the MV3 service worker can be evicted mid-request.
        for (const [id, p] of pending) {
          clearTimeout(p.timer);
          pending.delete(id);
          p.reject(new Error("the browsight extension disconnected"));
        }
      }
    });
  });

  function request(message: BridgeMessage, id: string): Promise<BridgeMessage> {
    return new Promise((resolve, reject) => {
      if (listenError) {
        reject(new Error(listenError));
        return;
      }
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
    async actActiveTab(req) {
      const id = randomUUID();
      const message: BridgeMessage = {
        type: "act.request",
        id,
        ref: req.ref,
        action: req.action,
        ...(req.value === undefined ? {} : { value: req.value }),
      };
      return (await request(message, id)) as ActResponse;
    },
    async listTabs(select) {
      const id = randomUUID();
      const res = await request({ type: "tabs.request", id, select }, id);
      return res as TabsResponse;
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
