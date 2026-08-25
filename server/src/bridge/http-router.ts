/**
 * Turning one loopback HTTP request into the right bridge action.
 *
 * Every frame between the extension and the server arrives here: the extension's auth handshake and
 * grant count, the responses it sends back for requests it was given, and requests a caller makes of
 * it. The routing is kept separate from the bridge itself so the bridge is about the conversation
 * with the extension while this module is about the wire format carrying it.
 *
 * Security (method, origin, loopback) is enforced first, in `./security.ts`, before any body is read.
 */
import type * as http from "node:http";
import { type BridgeMessage, BridgeMessageSchema } from "@browsight/shared";
import { extractToken, tokensMatch } from "../utils/auth.ts";
import { HttpError, readJsonBody } from "../utils/http-utils.ts";
import type { ExtensionChannel } from "./extension-channel.ts";
import type { PendingRequests } from "./pending-requests.ts";
import { enforceRequestSecurity } from "./security.ts";

/** The frames that ask the extension to do something; each carries the id its response quotes. */
export type RequestFrame = Extract<
  BridgeMessage,
  { type: "read.request" | "act.request" | "tabs.request" }
>;

/** Handlers a caller can substitute for the real extension, used by tests and the lazy bridge. */
export interface RequestHandlers {
  onRead?: (msg: BridgeMessage) => Promise<BridgeMessage> | BridgeMessage;
  onAct?: (msg: BridgeMessage) => Promise<BridgeMessage> | BridgeMessage;
  onTabs?: (msg: BridgeMessage) => Promise<BridgeMessage> | BridgeMessage;
  onRequest?: (
    msg: BridgeMessage,
    res: http.ServerResponse,
  ) => Promise<BridgeMessage> | BridgeMessage;
}

export interface RouterDeps {
  readonly host: string;
  port(): number;
  token(): string;
  readonly channel: ExtensionChannel;
  readonly pending: PendingRequests;
  readonly handlers: RequestHandlers;
  /** Send a request to the extension and wait for its response. */
  forward(msg: RequestFrame): Promise<BridgeMessage>;
  /** The extension completed its handshake and told us its version. */
  onAuth(extensionVersion: string): void;
  onAccessStatus(activeGrantCount: number): void;
  /** The extension's stream went away. */
  onDetach(): void;
}

const JSON_HEADERS = { "Content-Type": "application/json", Connection: "close" } as const;
const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "close",
} as const;

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

function sendText(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "Content-Type": "text/plain", Connection: "close" }).end(body);
}

function acknowledge(res: http.ServerResponse): void {
  sendJson(res, 200, { ok: true });
}

/**
 * Whether this request is the extension opening its event stream, rather than sending a frame.
 * A stream request either targets the stream paths or asks for `text/event-stream`, and carries no
 * body beyond the auth handshake.
 */
function isStreamRequest(req: http.IncomingMessage, parsedUrl: URL, bodyJson: unknown): boolean {
  const wantsStream =
    parsedUrl.pathname === "/events" ||
    parsedUrl.pathname === "/sse" ||
    (req.headers.accept?.includes("text/event-stream") ?? false);
  if (!wantsStream) {
    return false;
  }
  if (!bodyJson || typeof bodyJson !== "object" || !("type" in bodyJson)) {
    return true;
  }
  return (bodyJson as Record<string, unknown>).type === "auth";
}

/** Whether the caller wants the response delivered as an event rather than a JSON body. */
function wantsEventResponse(req: http.IncomingMessage, parsedUrl: URL): boolean {
  return (
    (req.headers.accept?.includes("text/event-stream") ?? false) ||
    parsedUrl.pathname.includes("/sse") ||
    parsedUrl.pathname.includes("/events")
  );
}

/** The substituted handler for this frame type, if the caller wired one. */
function substituteFor(
  msg: RequestFrame,
  handlers: RequestHandlers,
): RequestHandlers["onRead"] | undefined {
  switch (msg.type) {
    case "read.request":
      return handlers.onRead;
    case "act.request":
      return handlers.onAct;
    default:
      return handlers.onTabs;
  }
}

export function createHttpHandler(
  deps: RouterDeps,
): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> {
  /** Produce the response for a request, preferring a substituted handler over the extension. */
  const resolveRequest = async (msg: RequestFrame, res: http.ServerResponse) => {
    const { handlers } = deps;
    const direct = substituteFor(msg, deps.handlers);
    if (direct) {
      return await direct(msg);
    }
    if (handlers.onRequest) {
      return await handlers.onRequest(msg, res);
    }
    // With no handler wired, forward to the extension and return what the browser actually says.
    // Synthesising an empty response instead would report success for a page that was never read.
    return await deps.forward(msg);
  };

  const handleRequestFrame = async (
    msg: RequestFrame,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    parsedUrl: URL,
  ) => {
    let response: BridgeMessage;
    try {
      response = await resolveRequest(msg, res);
    } catch (err) {
      // The extension is absent or timed out. Say so, rather than reporting an empty page as a
      // successful read.
      sendJson(res, 503, { error: err instanceof Error ? err.message : String(err) });
      return;
    }
    if (!response) {
      return;
    }
    if (wantsEventResponse(req, parsedUrl)) {
      res.writeHead(200, SSE_HEADERS);
      res.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
      res.end();
      return;
    }
    sendJson(res, 200, response);
  };

  const routeFrame = async (
    msg: BridgeMessage,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    parsedUrl: URL,
  ) => {
    switch (msg.type) {
      case "auth":
        deps.onAuth(msg.extensionVersion);
        sendJson(res, 200, { type: "auth.ok", status: "authenticated" });
        return;
      case "access.status":
        deps.onAccessStatus(msg.activeGrantCount);
        acknowledge(res);
        return;
      case "read.response":
      case "act.response":
      case "tabs.response":
        deps.pending.settle(msg.id, msg);
        acknowledge(res);
        return;
      case "read.request":
      case "act.request":
      case "tabs.request":
        await handleRequestFrame(msg, req, res, parsedUrl);
        return;
      default:
        acknowledge(res);
    }
  };

  return async (req, res) => {
    if (!enforceRequestSecurity(req, res)) {
      return;
    }

    const parsedUrl = new URL(req.url ?? "/", `http://${deps.host}:${deps.port()}`);

    let bodyJson: unknown;
    try {
      bodyJson = await readJsonBody(req);
    } catch (err) {
      if (err instanceof HttpError) {
        sendText(res, err.statusCode, err.message);
        return;
      }
      sendText(res, 500, "internal error");
      return;
    }

    if (!tokensMatch(extractToken(req), deps.token())) {
      sendText(res, 401, "unauthorized");
      return;
    }

    if (isStreamRequest(req, parsedUrl, bodyJson)) {
      deps.channel.attach(res, req, deps.onDetach);
      return;
    }

    let msg: BridgeMessage | null = null;
    if (bodyJson) {
      const parsed = BridgeMessageSchema.safeParse(bodyJson);
      msg = parsed.success ? parsed.data : null;
    }
    if (!msg) {
      acknowledge(res);
      return;
    }

    try {
      await routeFrame(msg, req, res, parsedUrl);
    } catch {
      sendText(res, 500, "request processing failed");
    }
  };
}
