/**
 * Everything a request must satisfy before the bridge will look at it: it has to come from the
 * loopback interface, use the one method the extension speaks, and carry the extension's own
 * origin. Kept in its own module so the whole trust boundary can be read, and tested, in one place.
 */
import type http from "node:http";
import { isLoopbackHostname } from "@browsight/shared";

/** Guards against DNS rebinding: a rebound hostname never looks loopback. */
export function isLoopbackHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  // A bracketed host is IPv6 with a literal port suffix; everything else splits on the first colon.
  const hostname = hostHeader.startsWith("[")
    ? hostHeader.slice(1, hostHeader.indexOf("]"))
    : (hostHeader.split(":")[0] ?? "");
  return isLoopbackHostname(hostname);
}

/**
 * The only origin allowed to reach the bridge from a browser.
 *
 * Pinned by the `key` field in the extension manifest. Update both together if the
 * extension is ever republished under a different identity.
 */
/** The only HTTP method the bridge accepts. */
export const BRIDGE_METHOD = "QUERY";

/**
 * How long a tool call waits for the extension to attach before giving up. Chrome clamps extension
 * alarms to a one-minute floor, so anything shorter would report a failure the extension was about
 * to resolve on its own.
 */
export const EXTENSION_WAIT_MS = 70_000;

export const EXTENSION_ORIGIN = "chrome-extension://epilnkpfdfmdapnipbpcoopaedjfkohg";

export function parseExtensionOrigin(originHeader: string | undefined): string | null {
  return originHeader === EXTENSION_ORIGIN ? EXTENSION_ORIGIN : null;
}

/**
 * Applies the bridge's browser-facing rules. Returns false once the response has
 * been written. Non-browser MCP clients send no Origin and pass straight through.
 */
export function enforceRequestSecurity(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): boolean {
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
