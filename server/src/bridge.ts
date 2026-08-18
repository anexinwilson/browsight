import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type Action,
  type ActRequest,
  type ActResponse,
  type BridgeMessage,
  BridgeMessageSchema,
  type ReadRequest,
  type ReadResponse,
  type TabsRequest,
  type TabsResponse,
} from "@browsight/shared";
import { extractToken, tokensMatch } from "./utils/auth.ts";
import { HttpError, readJsonBody } from "./utils/http-utils.ts";

const REQUEST_TIMEOUT_MS = 30_000;

/** Where `setup` installs the extension, so errors can name the exact folder. */
export function extensionLoadPath(): string {
  return join(process.env.BROWSIGHT_HOME ?? homedir(), ".browsight", "extension");
}

export function bridgeConfigPath(): string {
  return join(process.env.BROWSIGHT_HOME ?? homedir(), ".browsight", "bridge.json");
}

/** The port and token currently on disk, or null if unreadable. */
export function readBridgeConfig(path: string): { port: number; token: string } | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed.port === "number" && typeof parsed.token === "string") {
      return { port: parsed.port, token: parsed.token };
    }
  } catch {}
  return null;
}

/** Guards against DNS rebinding: a rebound hostname never looks loopback. */
export function isLoopbackHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const hostname = hostHeader.startsWith("[")
    ? hostHeader.slice(1, hostHeader.indexOf("]"))
    : hostHeader.split(":")[0];
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

/**
 * The only origin allowed to reach the bridge from a browser.
 *
 * Pinned by the `key` field in the extension manifest. Update both together if the
 * extension is ever republished under a different identity.
 */
/** The only HTTP method the bridge accepts. */
export const BRIDGE_METHOD = "QUERY";

export const EXTENSION_ORIGIN = "chrome-extension://epilnkpfdfmdapnipbpcoopaedjfkohg";

export function parseExtensionOrigin(originHeader: string | undefined): string | null {
  return originHeader === EXTENSION_ORIGIN ? EXTENSION_ORIGIN : null;
}

/**
 * Applies the bridge's browser-facing rules. Returns false once the response has
 * been written. Non-browser MCP clients send no Origin and pass straight through.
 */
function enforceRequestSecurity(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const deny = () => {
    res.writeHead(403, { "Content-Type": "text/plain", Connection: "close" }).end("forbidden");
    return false;
  };

  if (!isLoopbackHost(req.headers.host)) return deny();

  const extensionOrigin = parseExtensionOrigin(req.headers.origin);
  if (extensionOrigin) {
    res.setHeader("Access-Control-Allow-Origin", extensionOrigin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, QUERY, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-Browsight-Token, X-Extension-Version",
    );
    // Chrome's Private Network Access preflight, scoped to the extension.
    res.setHeader("Access-Control-Allow-Private-Network", "true");
  }

  if (req.method === "OPTIONS") {
    if (!extensionOrigin) return deny();
    res.writeHead(204).end();
    return false;
  }

  // CORS only withholds the response, so reject here or a page still drives side effects.
  if (req.headers.origin !== undefined && !extensionOrigin) return deny();

  // The extension speaks QUERY and nothing else. Refusing every other method drops the request
  // before the token is even read, and because QUERY is not a CORS simple request it cannot be
  // produced by a form, an image tag or a bare fetch, so a hostile page has no way to reach here.
  if (req.method !== BRIDGE_METHOD) return deny();

  return true;
}

interface Pending {
  readonly resolve: (msg: BridgeMessage) => void;
  readonly reject: (err: Error) => void;
  readonly timer: NodeJS.Timeout;
}

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

export interface Bridge {
  readonly ready: Promise<void>;
  status(): BridgeStatus;
  reloadConfig(): Promise<ReloadResult>;
  readActiveTab(url: string | null, mode?: "full" | "main"): Promise<ReadResponse>;
  actActiveTab(req: { ref: string; action: Action; value?: string }): Promise<ActResponse>;
  listTabs(select: string | null): Promise<TabsResponse>;
  close(): Promise<void>;
}

export function startBridge(opts: BridgeOptions): Bridge {
  const pending = new Map<string, Pending>();
  let activeSseRes: http.ServerResponse | null = null;
  const host = opts.host || "127.0.0.1";
  let currentPort = opts.port;
  let currentToken = opts.token;
  let extensionVersion: string | null = null;
  let everSawExtension = false;
  let activeGrants = 0;
  let listenError: string | null = null;
  let resolveReady!: () => void;
  let rejectReady!: (err: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const handleSseStream = (res: http.ServerResponse, req: http.IncomingMessage) => {
    if (activeSseRes && activeSseRes !== res) {
      try {
        activeSseRes.write(
          `event: close\ndata: ${JSON.stringify({ reason: "replaced by a newer extension connection" })}\n\n`,
        );
        activeSseRes.end();
      } catch {}
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "close",
    });
    res.write(": connected\n\n");
    activeSseRes = res;

    let cleanedUp = false;
    const handleDisconnect = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      if (activeSseRes === res) {
        activeSseRes = null;
        extensionVersion = null;
        activeGrants = 0;
        opts.onAccessStatus?.(0);
        for (const [id, p] of pending) {
          clearTimeout(p.timer);
          pending.delete(id);
          p.reject(new Error("the browsight extension disconnected"));
        }
      }
    };

    req.on("close", handleDisconnect);
    req.on("aborted", handleDisconnect);
    res.on("close", handleDisconnect);
    req.socket?.on("close", handleDisconnect);
  };

  const processAppRoute = async (
    msg: BridgeMessage,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    parsedUrl: URL,
  ) => {
    if (msg.type === "auth") {
      extensionVersion = msg.extensionVersion;
      everSawExtension = true;
      res.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
      res.end(JSON.stringify({ type: "auth.ok", status: "authenticated" }));
      return;
    }

    if (msg.type === "access.status") {
      activeGrants = msg.activeGrantCount;
      opts.onAccessStatus?.(msg.activeGrantCount);
      res.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (
      msg.type === "read.response" ||
      msg.type === "act.response" ||
      msg.type === "tabs.response"
    ) {
      handleResponseMsg(msg, res);
      return;
    }

    if (msg.type === "read.request" || msg.type === "act.request" || msg.type === "tabs.request") {
      await handleRequestMsg(msg, req, res, parsedUrl);
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
    res.end(JSON.stringify({ ok: true }));
  };

  type BridgeResponseMessage = Extract<
    BridgeMessage,
    { type: "read.response" | "act.response" | "tabs.response" }
  >;

  const handleResponseMsg = (msg: BridgeResponseMessage, res: http.ServerResponse) => {
    const p = pending.get(msg.id);
    if (p) {
      clearTimeout(p.timer);
      pending.delete(msg.id);
      p.resolve(msg);
    }
    res.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
    res.end(JSON.stringify({ ok: true }));
  };

  const getResponseForMessage = async (
    msg: BridgeMessage,
    res: http.ServerResponse,
  ): Promise<BridgeMessage | undefined> => {
    // With no handler wired, forward the request to the extension and return what the
    // browser actually says. Returning a synthesised empty response instead would
    // report success for a page that was never read.
    if (msg.type === "read.request") {
      if (opts.onRead) return await opts.onRead(msg);
      if (opts.onRequest) return await opts.onRequest(msg, res);
      return await request(msg, msg.id);
    }
    if (msg.type === "act.request") {
      if (opts.onAct) return await opts.onAct(msg);
      if (opts.onRequest) return await opts.onRequest(msg, res);
      return await request(msg, msg.id);
    }
    if (msg.type === "tabs.request") {
      if (opts.onTabs) return await opts.onTabs(msg);
      if (opts.onRequest) return await opts.onRequest(msg, res);
      return await request(msg, msg.id);
    }
    return undefined;
  };

  const handleRequestMsg = async (
    msg: BridgeMessage,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    parsedUrl: URL,
  ) => {
    let response: BridgeMessage | undefined;
    try {
      response = await getResponseForMessage(msg, res);
    } catch (err) {
      // The extension is absent or timed out. Say so, rather than reporting an
      // empty page as a successful read.
      res.writeHead(503, { "Content-Type": "application/json", Connection: "close" });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      return;
    }

    if (response) {
      const wantsSse =
        req.headers.accept?.includes("text/event-stream") ||
        parsedUrl.pathname.includes("/sse") ||
        parsedUrl.pathname.includes("/events");
      if (wantsSse) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "close",
        });
        res.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
        res.end();
      } else {
        res.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
        res.end(JSON.stringify(response));
      }
    }
  };

  const handleHttp = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    if (!enforceRequestSecurity(req, res)) return;

    const parsedUrl = new URL(req.url ?? "/", `http://${host}:${currentPort}`);

    let bodyJson: unknown = null;
    try {
      bodyJson = await readJsonBody(req);
    } catch (err) {
      if (err instanceof HttpError) {
        res
          .writeHead(err.statusCode, { "Content-Type": "text/plain", Connection: "close" })
          .end(err.message);
        return;
      }
      res
        .writeHead(500, { "Content-Type": "text/plain", Connection: "close" })
        .end("internal error");
      return;
    }

    const token = extractToken(req);
    if (!tokensMatch(token, currentToken)) {
      res.writeHead(401, { "Content-Type": "text/plain", Connection: "close" }).end("unauthorized");
      return;
    }

    const isSseStreamRequest =
      (parsedUrl.pathname === "/events" ||
        parsedUrl.pathname === "/sse" ||
        req.headers.accept?.includes("text/event-stream")) &&
      (!bodyJson ||
        typeof bodyJson !== "object" ||
        !("type" in bodyJson) ||
        (bodyJson as Record<string, unknown>).type === "auth");

    if (isSseStreamRequest) {
      handleSseStream(res, req);
      return;
    }

    let msg: BridgeMessage | null = null;
    if (bodyJson) {
      try {
        msg = BridgeMessageSchema.parse(bodyJson);
      } catch {
        // Not a standard BridgeMessage schema
      }
    }

    if (msg) {
      try {
        await processAppRoute(msg, req, res, parsedUrl);
        return;
      } catch {
        res
          .writeHead(500, { "Content-Type": "text/plain", Connection: "close" })
          .end("request processing failed");
        return;
      }
    }

    res.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
    res.end(JSON.stringify({ ok: true }));
  };

  let server = http.createServer(handleHttp);

  server.listen({ host, port: currentPort }, () => {
    resolveReady();
  });

  server.on("error", (err: Error) => {
    const code = (err as NodeJS.ErrnoException).code;
    listenError =
      code === "EADDRINUSE"
        ? `another browsight instance is already using ${host}:${currentPort}, only one client can drive browsight at a time; close it in the other client, or drive browsight from there.`
        : `the browsight bridge could not start: ${err.message}`;
    rejectReady(new Error(listenError));
  });

  /**
   * Binds a second listener before giving up the first.
   *
   * If the new port is taken we still hold the old one, so a failed reload leaves a
   * working bridge rather than none. Checking the port before binding would race:
   * the only reliable test is the bind itself.
   */
  function listenOn(port: number): Promise<http.Server> {
    return new Promise((resolve, reject) => {
      const candidate = http.createServer(handleHttp);
      const onError = (err: Error) => {
        candidate.close();
        reject(err);
      };
      candidate.once("error", onError);
      candidate.listen({ host, port }, () => {
        candidate.removeListener("error", onError);
        resolve(candidate);
      });
    });
  }

  async function reloadConfig(): Promise<ReloadResult> {
    if (!opts.configPath) {
      return { changed: false, detail: "this bridge was not started from a config file." };
    }
    const onDisk = readBridgeConfig(opts.configPath);
    if (!onDisk) {
      return { changed: false, detail: `could not read ${opts.configPath}.` };
    }
    if (onDisk.port === currentPort && onDisk.token === currentToken) {
      return { changed: false, detail: `config unchanged; still on port ${currentPort}.` };
    }

    const previousPort = currentPort;
    if (onDisk.port !== currentPort) {
      let replacement: http.Server;
      try {
        replacement = await listenOn(onDisk.port);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        return {
          changed: false,
          detail:
            code === "EADDRINUSE"
              ? `port ${onDisk.port} is already in use, so this server stayed on ${currentPort}. Another browsight may still be running.`
              : `could not bind port ${onDisk.port}: ${(err as Error).message}. Still on ${currentPort}.`,
        };
      }
      const old = server;
      server = replacement;
      currentPort = onDisk.port;
      await new Promise<void>((resolve) => {
        old.close(() => resolve());
        old.closeAllConnections?.();
      });
      // The extension was talking to the old listener; it reconnects to the new one.
      activeSseRes = null;
      extensionVersion = null;
    }

    currentToken = onDisk.token;
    listenError = null;
    return {
      changed: true,
      detail: `moved from port ${previousPort} to ${currentPort}; reload the browsight extension in Chrome if it does not reconnect on its own.`,
    };
  }

  /**
   * Explains why no extension is attached. A frequent cause is not a missing
   * extension but a stale server: `setup` rewrote bridge.json after this process
   * booted, so the extension is dialling a port nobody is listening on.
   */
  function disconnectedReason(): string {
    const onDisk = opts.configPath ? readBridgeConfig(opts.configPath) : null;
    if (onDisk && (onDisk.port !== currentPort || onDisk.token !== currentToken)) {
      return `browsight was reconfigured after this server started (this server is on port ${currentPort}, the config now says port ${onDisk.port}). Fix: call browser_status with reload=true, or restart your MCP client.`;
    }
    // Everything a caller needs to act is in this one string. A separate diagnostic
    // tool cannot be relied on: MCP clients discover tools once at connect time, so a
    // newly added tool is invisible until the client restarts, which is exactly when
    // something has just changed and diagnosis matters most.
    const seen = everSawExtension
      ? "The extension connected earlier and has since dropped"
      : "The extension has not connected since this server started";
    return `${seen}. browsight is listening on 127.0.0.1:${currentPort}, so the server side is healthy. Fix: open chrome://extensions and reload the browsight extension (it must be loaded from ${extensionLoadPath()}). It also retries on its own about once a minute.`;
  }

  function request(message: BridgeMessage, id: string): Promise<BridgeMessage> {
    return new Promise((resolve, reject) => {
      if (listenError) {
        reject(new Error(listenError));
        return;
      }
      if (!activeSseRes) {
        reject(new Error(disconnectedReason()));
        return;
      }
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("timed out waiting for the extension"));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      try {
        activeSseRes.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
      } catch (err) {
        clearTimeout(timer);
        pending.delete(id);
        reject(new Error(`failed to send message over SSE: ${String(err)}`));
      }
    });
  }

  return {
    ready,
    status() {
      const onDisk = opts.configPath ? readBridgeConfig(opts.configPath) : null;
      // Report the port actually bound, not the one requested: with port 0 the OS
      // chooses, and after a reload the two can differ.
      const bound = server.address();
      const port = typeof bound === "object" && bound ? bound.port : currentPort;
      return {
        extensionConnected: activeSseRes !== null,
        // Same function the thrown errors use, so the two can never disagree.
        detail: activeSseRes ? "extension connected" : listenError || disconnectedReason(),
        port,
        configPort: onDisk ? onDisk.port : null,
        extensionVersion,
        activeGrants,
      };
    },
    reloadConfig,
    async readActiveTab(url, mode = "full") {
      const id = randomUUID();
      const res = await request({ type: "read.request", id, url, mode, schema: null }, id);
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
      for (const [id, p] of pending) {
        clearTimeout(p.timer);
        pending.delete(id);
        p.reject(new Error("bridge closed"));
      }
      if (activeSseRes) {
        try {
          activeSseRes.end();
        } catch {}
        activeSseRes = null;
      }
      return new Promise((resolve) => {
        server.close(() => resolve());
        if (typeof server.closeAllConnections === "function") {
          server.closeAllConnections();
        }
      });
    },
  };
}
