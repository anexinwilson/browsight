/**
 * The service worker: the bridge client and message router. It connects to the local server over
 * a token-authenticated HTTP / SSE transport, reconnects on wake, and dispatches each request to
 * its handler in ./messaging. The deterministic permission gate is enforced inside those handlers,
 * not here.
 */
import { type BridgeMessage, BridgeMessageSchema } from "@browsight/shared";
import { handleAct } from "./messaging/act.ts";
import { handleRead } from "./messaging/read.ts";
import { handleTabs } from "./messaging/tabs.ts";
import { listGrants } from "./permissions/storage.ts";
import { connectSse } from "./transport/sse.ts";

interface Connection {
  readonly port: number;
  readonly token: string;
  readonly host: string;
}

// Loopback-only allowlist, this extension is a local bridge and must never connect to remote hosts.
const ALLOWED_HOSTS = ["127.0.0.1", "localhost"] as const;

export const MAX_CONNECTION_RETRIES = 3;
export const KEEPALIVE_ALARM = "browsight-keepalive";
export const KEEPALIVE_INTERVAL_MINUTES = 0.4;
/**
 * How often to retry while dormant. The server only binds its port when a browser
 * tool is called, so a dormant extension must keep checking back, but slowly,
 * rather than hammering a port that is deliberately closed.
 */
export const DORMANT_RETRY_INTERVAL_MINUTES = 1;

let consecutiveFailures = 0;
/** Timestamp of the last dormant retry, so the retry rate never depends on Chrome. */
let lastDormantRetryAt = 0;
let isSleeping = false;
let connectionAttempt: Promise<void> | null = null;
let activeAbortController: AbortController | null = null;
let activeEventSource: EventSource | null = null;

export function getConsecutiveFailures(): number {
  return consecutiveFailures;
}

export function getRetryCount(): number {
  return consecutiveFailures;
}

export function isExtensionSleeping(): boolean {
  return isSleeping;
}

export function setConsecutiveFailures(count: number): void {
  consecutiveFailures = count;
}

export function setRetryCount(count: number): void {
  consecutiveFailures = count;
}

export function setSleeping(sleeping: boolean): void {
  isSleeping = sleeping;
}

export function setActiveController(c: AbortController | null): void {
  activeAbortController = c;
}

export function disconnect(): void {
  connectionAttempt = null;
  if (activeAbortController) {
    activeAbortController.abort();
    activeAbortController = null;
  }
  if (activeEventSource) {
    try {
      activeEventSource.close();
    } catch {
      // ignore
    }
    activeEventSource = null;
  }
}

async function setSleepBadge(): Promise<void> {
  if (typeof chrome !== "undefined" && chrome.action) {
    try {
      if (chrome.action.setBadgeText) {
        await chrome.action.setBadgeText({ text: "ZZZ" });
      }
      if (chrome.action.setBadgeBackgroundColor) {
        await chrome.action.setBadgeBackgroundColor({ color: "#6c757d" });
      }
    } catch {
      // Action API call failed in test or unsupported context
    }
  }
}

async function clearBadge(): Promise<void> {
  if (typeof chrome !== "undefined" && chrome.action?.setBadgeText) {
    try {
      await chrome.action.setBadgeText({ text: "" });
    } catch {
      // ignore
    }
  }
}

export async function enterSleepMode(): Promise<void> {
  isSleeping = true;
  disconnect();
  // Slow the alarm down instead of clearing it. Clearing it meant the only way back
  // was a toolbar click, which would strand the first tool call after the server
  // released its port.
  if (typeof chrome !== "undefined" && chrome.alarms?.create) {
    try {
      await chrome.alarms.create(KEEPALIVE_ALARM, {
        periodInMinutes: DORMANT_RETRY_INTERVAL_MINUTES,
      });
    } catch {
      // ignore
    }
  }
  await setSleepBadge();
  console.info("browsight: dormant after repeated connection failures; retrying slowly");
}

export async function wakeUp(): Promise<void> {
  lastDormantRetryAt = 0;
  consecutiveFailures = 0;
  isSleeping = false;
  disconnect();
  await clearBadge();
  if (typeof chrome !== "undefined" && chrome.alarms?.create) {
    try {
      await chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_INTERVAL_MINUTES });
    } catch {
      // ignore
    }
  }
  await connect();
}

async function handleConnectionFailure(error?: unknown): Promise<void> {
  disconnect();
  if (isSleeping) {
    return;
  }
  if (error) {
    reportConnectionError(error);
  }
  // The server binds its port only while a tool is in use, so finding nothing listening is the
  // normal resting state, not a fault. Counting it would push the extension into dormant mode
  // simply for sitting idle, and it would then reconnect slowly once the server did come back.
  if (isServerNotListening(error)) {
    return;
  }
  consecutiveFailures++;
  if (consecutiveFailures >= MAX_CONNECTION_RETRIES) {
    await enterSleepMode();
  }
}

/** The manifest is the single source of truth for the version the server is told about. */
function extensionVersion(): string {
  return chrome.runtime.getManifest().version;
}

export async function send(msg: BridgeMessage): Promise<void> {
  const conn = await loadConnection();
  if (!conn) return;
  const safeHost = conn.host === "localhost" ? "localhost" : "127.0.0.1";
  const safePort = Number.parseInt(String(conn.port), 10);
  if (Number.isNaN(safePort) || safePort < 1 || safePort > 65535) return;
  const url = `http://${safeHost}:${safePort}/message`;
  try {
    const version = extensionVersion();
    await fetch(url, {
      method: "QUERY",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${conn.token}`,
        "X-Extension-Version": version,
      },
      body: JSON.stringify(msg),
    });
  } catch (err) {
    reportConnectionError(err);
  }
}

export async function reportAccessStatus(): Promise<void> {
  const activeGrantCount = (await listGrants()).length;
  await send({ type: "access.status", activeGrantCount });
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
    // Not set up yet, `npm run setup` writes connection.json.
  }
  return null;
}

async function openConnection(force = false): Promise<void> {
  if (isSleeping && !force) {
    return;
  }
  if ((activeAbortController && !activeAbortController.signal.aborted) || activeEventSource) {
    return;
  }
  const conn = await loadConnection();
  if (!conn) {
    await handleConnectionFailure(new Error("missing connection.json"));
    return;
  }
  const safeHost = ALLOWED_HOSTS.find((h) => h === conn.host);
  if (!safeHost) {
    await handleConnectionFailure(new Error("disallowed host"));
    return;
  }
  const safePort = Number.parseInt(String(conn.port), 10);
  if (Number.isNaN(safePort) || safePort < 1 || safePort > 65535) {
    await handleConnectionFailure(new Error("invalid port"));
    return;
  }

  const version = extensionVersion();

  // Transport: SSE for commands from the server, HTTP QUERY for results back.
  try {
    const controller = await connectSse(
      conn.token,
      safeHost,
      safePort,
      (raw) => void route(raw),
      () => {
        if (activeAbortController === controller) {
          activeAbortController = null;
        }
      },
      version,
    );

    if (!controller) {
      activeAbortController = null;
      return;
    }

    // Success resets consecutive failures and clears sleep badge
    activeAbortController = controller;
    const wasDormant = isSleeping;
    consecutiveFailures = 0;
    isSleeping = false;
    await clearBadge();
    // Coming back from dormant, restore the responsive keepalive interval.
    if (wasDormant && typeof chrome !== "undefined" && chrome.alarms?.create) {
      try {
        await chrome.alarms.create(KEEPALIVE_ALARM, {
          periodInMinutes: KEEPALIVE_INTERVAL_MINUTES,
        });
      } catch {
        // ignore
      }
    }
    await reportAccessStatus();
  } catch (err) {
    await handleConnectionFailure(err);
  }
}

export async function connect(options?: { readonly force?: boolean }): Promise<void> {
  // `force` is used only by the dormant retry alarm, which fires once a minute.
  // Every other caller stays blocked while dormant so a burst of page events cannot
  // hammer a port the server has deliberately closed.
  if (isSleeping && !options?.force) {
    return;
  }
  if ((activeAbortController && !activeAbortController.signal.aborted) || activeEventSource) {
    return;
  }
  if (connectionAttempt) {
    return connectionAttempt;
  }
  connectionAttempt = openConnection(options?.force ?? false);
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

if (typeof chrome !== "undefined" && chrome.runtime?.onInstalled) {
  chrome.runtime.onInstalled.addListener(() => {
    if (!isSleeping) {
      requestConnection();
    }
  });
}
if (typeof chrome !== "undefined" && chrome.runtime?.onStartup) {
  chrome.runtime.onStartup.addListener(() => {
    if (!isSleeping) {
      requestConnection();
    }
  });
}
if (typeof chrome !== "undefined" && chrome.alarms?.create) {
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_INTERVAL_MINUTES });
}
if (typeof chrome !== "undefined" && chrome.alarms?.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm?: { name?: string }) => {
    if (alarm?.name && alarm.name !== KEEPALIVE_ALARM) {
      return;
    }
    if (isSleeping) {
      // The single channel back from dormancy, rate-limited here rather than trusting
      // the alarm to fire no faster than it was scheduled.
      const now = Date.now();
      if (now - lastDormantRetryAt < DORMANT_RETRY_INTERVAL_MINUTES * 60_000) {
        return;
      }
      lastDormantRetryAt = now;
      void connect({ force: true }).catch(reportConnectionError);
      return;
    }
    requestConnection();
    void reportAccessStatus().catch(reportConnectionError);
  });
}

if (typeof chrome !== "undefined" && chrome.action?.onClicked) {
  chrome.action.onClicked.addListener(() => {
    wakeUp().catch(reportConnectionError);
  });
}

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "wakeUp") {
      wakeUp().catch(reportConnectionError);
    }
  });
}

/**
 * The server binds its port only while a browser tool is in use, so "nothing is listening" is the
 * normal resting state rather than a fault. Reporting it through console.error puts a red Errors
 * badge on the extension card for a healthy install, so it is logged quietly and only genuine
 * failures (a rejected token, a malformed reply) are raised as errors.
 */
function isServerNotListening(error: unknown): boolean {
  // Matched on name and message rather than `instanceof TypeError`: the rejection can cross a
  // bundle or realm boundary, where the identity check silently fails and the error surfaces on
  // the extension card again.
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const { name, message } = error as { name?: unknown; message?: unknown };
  if (name === "AbortError") {
    return true;
  }
  if (name !== "TypeError" || typeof message !== "string") {
    return false;
  }
  return /failed to fetch|networkerror|load failed|connection refused/i.test(message);
}

function reportConnectionError(error: unknown): void {
  if (isServerNotListening(error)) {
    console.debug("browsight: local server not listening (idle)", error);
    return;
  }
  console.error("browsight connection failed", error);
}

export function requestConnection(): void {
  if (isSleeping) {
    return;
  }
  connect().catch(reportConnectionError);
}

// Extension service workers reject top-level await even when the manifest declares an ESM worker.
// Start asynchronously so registration can finish before the first bridge connection attempt.
requestConnection();
