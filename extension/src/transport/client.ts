/**
 * Talking to the local bridge: opening the event stream, and posting results back.
 *
 * Two directions, two mechanisms. Commands arrive over SSE, which the server holds open; results go
 * back as individual HTTP QUERY requests. Both are authenticated with the token in `connection.json`
 * and both are pinned to loopback, so a rewritten config can never point the extension at a remote
 * host.
 *
 * The handler for incoming frames is passed in rather than imported, because routing depends on this
 * module to send its replies. Injecting it keeps the dependency in one direction.
 */
import {
  type BridgeMessage,
  type Connection,
  isLoopbackHostname,
  parseConnection,
} from "@browsight/shared";
import { listGrants } from "../permissions/storage.ts";
import { clearBadge } from "./badge.ts";
import {
  getActiveController,
  getConnectionAttempt,
  hasLiveConnection,
  isExtensionSleeping,
  setActiveController,
  setConnectionAttempt,
  setConsecutiveFailures,
  setSleeping,
} from "./connection-state.ts";
import { handleConnectionFailure } from "./dormancy.ts";
import { reportConnectionError } from "./errors.ts";
import { KEEPALIVE_INTERVAL_MINUTES, scheduleKeepalive } from "./keepalive.ts";
import { connectSse } from "./sse.ts";

/** Incoming bridge frames, delivered as raw text for the caller to parse and dispatch. */
export type MessageHandler = (raw: string) => void;

/** The manifest is the single source of truth for the version the server is told about. */
function extensionVersion(): string {
  return chrome.runtime.getManifest().version;
}

export async function loadConnection(): Promise<Connection | null> {
  try {
    const res = await fetch(chrome.runtime.getURL("connection.json"));
    // Same schema the server validates against, so the two can never disagree about what a valid
    // handshake looks like.
    return parseConnection(await res.json());
  } catch {
    // Not set up yet; `npx browsight setup` writes connection.json.
    return null;
  }
}

/** Post one message back to the server. Failures are reported, never thrown at the caller. */
export async function send(msg: BridgeMessage): Promise<void> {
  const conn = await loadConnection();
  if (!conn) {
    return;
  }
  const safeHost = conn.host === "localhost" ? "localhost" : "127.0.0.1";
  const safePort = Number.parseInt(String(conn.port), 10);
  if (Number.isNaN(safePort) || safePort < 1 || safePort > 65535) {
    return;
  }
  try {
    await fetch(`http://${safeHost}:${safePort}/message`, {
      method: "QUERY",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${conn.token}`,
        "X-Extension-Version": extensionVersion(),
      },
      body: JSON.stringify(msg),
    });
  } catch (err) {
    reportConnectionError(err);
  }
}

/** Tell the server how many sites are currently allowed. A count only, never the origins. */
export async function reportAccessStatus(): Promise<void> {
  const activeGrantCount = (await listGrants()).length;
  await send({ type: "access.status", activeGrantCount });
}

async function openConnection(onMessage: MessageHandler, force: boolean): Promise<void> {
  if ((isExtensionSleeping() && !force) || hasLiveConnection()) {
    return;
  }
  const conn = await loadConnection();
  if (!conn) {
    await handleConnectionFailure(new Error("missing connection.json"));
    return;
  }
  // A local bridge must never reach a remote host, and the schema has already bounded the port.
  if (!isLoopbackHostname(conn.host)) {
    await handleConnectionFailure(new Error("disallowed host"));
    return;
  }

  try {
    const controller = await connectSse(
      conn.token,
      conn.host,
      conn.port,
      onMessage,
      () => {
        if (getActiveController() === controller) {
          setActiveController(null);
        }
      },
      extensionVersion(),
    );
    if (!controller) {
      setActiveController(null);
      return;
    }

    setActiveController(controller);
    const wasDormant = isExtensionSleeping();
    setConsecutiveFailures(0);
    setSleeping(false);
    await clearBadge();
    // Coming back from dormant, restore the responsive keepalive interval.
    if (wasDormant) {
      await scheduleKeepalive(KEEPALIVE_INTERVAL_MINUTES);
    }
    await reportAccessStatus();
  } catch (err) {
    await handleConnectionFailure(err);
  }
}

/**
 * Connect, unless one is already live or in flight.
 *
 * `force` is used only by the dormant retry alarm, which fires once a minute. Every other caller
 * stays blocked while dormant so a burst of page events cannot hammer a port the server has
 * deliberately closed.
 */
export async function connect(
  onMessage: MessageHandler,
  options?: { readonly force?: boolean },
): Promise<void> {
  if (isExtensionSleeping() && !options?.force) {
    return;
  }
  if (hasLiveConnection()) {
    return;
  }
  const inFlight = getConnectionAttempt();
  if (inFlight) {
    return inFlight;
  }
  const attempt = openConnection(onMessage, options?.force ?? false);
  setConnectionAttempt(attempt);
  try {
    await attempt;
  } finally {
    setConnectionAttempt(null);
  }
}
