/**
 * The conversation with the browser extension.
 *
 * This module composes the pieces and exposes what the MCP tools actually need: read a tab, act on
 * one, list them, and say whether any of that is possible right now. The mechanics live next door,
 * each owning its own state:
 *
 * - `./listener.ts`         binding the loopback port, and moving it when setup rewrites the config
 * - `./extension-channel.ts` the event stream the extension listens on
 * - `./pending-requests.ts` matching a sent request to the response that comes back
 * - `./http-router.ts`      turning an incoming request into one of the above
 * - `./security.ts`         the trust boundary, enforced before anything else runs
 */
import { randomUUID } from "node:crypto";
import type * as http from "node:http";
import type {
  Action,
  ActRequest,
  ActResponse,
  BridgeMessage,
  FieldFill,
  ReadRequest,
  ReadResponse,
  TabsRequest,
  TabsResponse,
} from "@browsight/shared";
import { errorCode } from "../utils/errors.ts";
import { readBridgeConfig } from "./config.ts";
import { disconnectedReason as describeDisconnect } from "./diagnostics.ts";
import { createExtensionChannel } from "./extension-channel.ts";
import { createHttpHandler } from "./http-router.ts";
import { startListener } from "./listener.ts";
import { createPendingRequests } from "./pending-requests.ts";
import { EXTENSION_WAIT_MS } from "./security.ts";

/** How long one request may wait for the extension to answer before it is abandoned. */
const REQUEST_TIMEOUT_MS = 30_000;

export interface BridgeOptions {
  readonly port: number;
  readonly token: string;
  readonly host?: string;
  /**
   * Path to the bridge.json these options came from. Set it and a disconnect can
   * distinguish "extension never loaded" from "setup ran after this server booted".
   * Left unset, the bridge never consults the filesystem.
   */
  readonly configPath?: string;
  /**
   * How long a tool call waits for the extension to attach before giving up. Defaults to just over
   * Chrome's one-minute alarm floor; tests override it so they do not sit through the real wait.
   */
  readonly extensionWaitMs?: number;
  readonly onAccessStatus?: (activeGrantCount: number) => void;
  readonly onRequest?: (
    msg: BridgeMessage,
    res?: http.ServerResponse,
  ) => Promise<BridgeMessage | undefined> | BridgeMessage | undefined;
  readonly onRead?: (req: ReadRequest) => Promise<ReadResponse> | ReadResponse;
  readonly onAct?: (req: ActRequest) => Promise<ActResponse> | ActResponse;
  readonly onTabs?: (req: TabsRequest) => Promise<TabsResponse> | TabsResponse;
}

export interface ReloadResult {
  readonly changed: boolean;
  readonly detail: string;
}

export interface BridgeStatus {
  readonly extensionConnected: boolean;
  readonly detail: string;
  readonly port: number;
  readonly configPort: number | null;
  readonly extensionVersion: string | null;
  readonly activeGrants: number;
}

/** What a caller can ask of one read: which region, where to resume, and what to search for. */
export interface ReadOptions {
  readonly mode?: "full" | "main";
  readonly offset?: number;
  readonly query?: string | null;
}

export interface Bridge {
  readonly ready: Promise<void>;
  status(): BridgeStatus;
  reloadConfig(): Promise<ReloadResult>;
  readActiveTab(url: string | null, options?: ReadOptions): Promise<ReadResponse>;
  actActiveTab(req: {
    ref: string;
    action: Action;
    value?: string;
    fields?: FieldFill[];
  }): Promise<ActResponse>;
  listTabs(select: string | null): Promise<TabsResponse>;
  close(): Promise<void>;
}

export function startBridge(opts: BridgeOptions): Bridge {
  const host = opts.host || "127.0.0.1";
  const channel = createExtensionChannel();
  const pending = createPendingRequests();

  let currentToken = opts.token;
  let extensionVersion: string | null = null;
  let everSawExtension = false;
  let activeGrants = 0;

  /**
   * Explains why no extension is attached. A frequent cause is not a missing extension but a stale
   * server: `setup` rewrote bridge.json after this process booted, so the extension is dialling a
   * port nobody is listening on.
   */
  const disconnectedReason = (): string =>
    describeDisconnect({
      configPath: opts.configPath ?? null,
      currentPort: listener.port(),
      currentToken,
      everSawExtension,
    });

  /**
   * Send one message to the extension and wait for the matching response.
   *
   * The server holds its port only while a tool is in flight, so on a cold start the extension is
   * legitimately absent and arrives when Chrome next wakes its service worker. Waiting on the
   * connection turns that into a slow first call rather than a failure.
   */
  const request = async (message: BridgeMessage, id: string): Promise<BridgeMessage> => {
    if (!listener.error() && !channel.isConnected()) {
      await channel.awaitConnection(opts.extensionWaitMs ?? EXTENSION_WAIT_MS);
    }
    return new Promise<BridgeMessage>((resolve, reject) => {
      const failure = listener.error() ?? (channel.isConnected() ? null : disconnectedReason());
      if (failure) {
        reject(new Error(failure));
        return;
      }
      pending.track(id, REQUEST_TIMEOUT_MS, resolve, reject);
      try {
        channel.send(message);
      } catch (err) {
        pending.forget(id);
        reject(new Error(`failed to send message over SSE: ${String(err)}`));
      }
    });
  };

  const handleHttp = createHttpHandler({
    host,
    port: () => listener.port(),
    token: () => currentToken,
    channel,
    pending,
    handlers: {
      ...(opts.onRead ? { onRead: opts.onRead as never } : {}),
      ...(opts.onAct ? { onAct: opts.onAct as never } : {}),
      ...(opts.onTabs ? { onTabs: opts.onTabs as never } : {}),
      ...(opts.onRequest ? { onRequest: opts.onRequest as never } : {}),
    },
    forward: (msg) => request(msg, msg.id),
    onAuth: (version) => {
      extensionVersion = version;
      everSawExtension = true;
    },
    onAccessStatus: (count) => {
      activeGrants = count;
      opts.onAccessStatus?.(count);
    },
    onDetach: () => {
      extensionVersion = null;
      activeGrants = 0;
      opts.onAccessStatus?.(0);
      pending.rejectAll("the browsight extension disconnected");
    },
  });

  const listener = startListener(handleHttp, host, opts.port);

  /** Move onto the port and token `setup` last wrote, without dropping a working bridge. */
  async function reloadConfig(): Promise<ReloadResult> {
    if (!opts.configPath) {
      return { changed: false, detail: "this bridge was not started from a config file." };
    }
    const onDisk = readBridgeConfig(opts.configPath);
    if (!onDisk) {
      return { changed: false, detail: `could not read ${opts.configPath}.` };
    }
    const previousPort = listener.port();
    if (onDisk.port === previousPort && onDisk.token === currentToken) {
      return { changed: false, detail: `config unchanged; still on port ${previousPort}.` };
    }

    if (onDisk.port !== previousPort) {
      try {
        await listener.moveTo(onDisk.port);
      } catch (err) {
        return {
          changed: false,
          detail:
            errorCode(err) === "EADDRINUSE"
              ? `port ${onDisk.port} is already in use, so this server stayed on ${previousPort}. Another browsight may still be running.`
              : `could not bind port ${onDisk.port}: ${(err as Error).message}. Still on ${previousPort}.`,
        };
      }
      // The extension was talking to the old listener; it reconnects to the new one.
      channel.close();
      extensionVersion = null;
    }

    currentToken = onDisk.token;
    return {
      changed: true,
      detail: `moved from port ${previousPort} to ${listener.port()}; reload the browsight extension in Chrome if it does not reconnect on its own.`,
    };
  }

  return {
    ready: listener.ready,

    status() {
      const onDisk = opts.configPath ? readBridgeConfig(opts.configPath) : null;
      return {
        extensionConnected: channel.isConnected(),
        // Same function the thrown errors use, so the two can never disagree.
        detail: channel.isConnected()
          ? "extension connected"
          : (listener.error() ?? disconnectedReason()),
        port: listener.port(),
        configPort: onDisk ? onDisk.port : null,
        extensionVersion,
        activeGrants,
      };
    },

    reloadConfig,

    async readActiveTab(url, options = {}) {
      const id = randomUUID();
      const res = await request(
        {
          type: "read.request",
          id,
          url,
          mode: options.mode ?? "full",
          offset: options.offset ?? 0,
          query: options.query ?? null,
          schema: null,
        },
        id,
      );
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
        ...(req.fields === undefined ? {} : { fields: req.fields }),
      };
      return (await request(message, id)) as ActResponse;
    },

    async listTabs(select) {
      const id = randomUUID();
      const res = await request({ type: "tabs.request", id, select }, id);
      return res as TabsResponse;
    },

    close() {
      channel.close();
      pending.rejectAll("bridge closed");
      return listener.close();
    },
  };
}
