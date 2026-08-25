/**
 * The service worker: the extension's entry point.
 *
 * It wires Chrome's events to the transport and dispatches each incoming bridge frame to its
 * handler in `./messaging`. The mechanics live in `./transport`, each owning one concern:
 *
 * - `connection-state.ts` what is connected, and the one way to drop it
 * - `client.ts`           opening the event stream and posting results back
 * - `dormancy.ts`         backing off after real failures, and coming back
 * - `keepalive.ts`        the alarm that revives a suspended worker
 *
 * The deterministic permission gate is enforced inside the messaging handlers, not here.
 */
import { type BridgeMessage, BridgeMessageSchema } from "@browsight/shared";
import { handleAct } from "./messaging/act.ts";
import { handleRead } from "./messaging/read.ts";
import { handleTabs } from "./messaging/tabs.ts";
import { connect as openBridgeConnection, reportAccessStatus, send } from "./transport/client.ts";
import {
  getLastDormantRetryAt,
  isExtensionSleeping,
  setLastDormantRetryAt,
} from "./transport/connection-state.ts";
import { leaveSleepMode, mayRetryWhileDormant } from "./transport/dormancy.ts";
import { reportConnectionError } from "./transport/errors.ts";
import {
  KEEPALIVE_ALARM,
  KEEPALIVE_INTERVAL_MINUTES,
  scheduleKeepalive,
} from "./transport/keepalive.ts";

export { loadConnection, reportAccessStatus, send } from "./transport/client.ts";
// The worker's state and policy are re-exported so this module stays the extension's single entry
// point, for tests as much as for Chrome.
export {
  disconnect,
  getConsecutiveFailures,
  getConsecutiveFailures as getRetryCount,
  isExtensionSleeping,
  setActiveController,
  setConsecutiveFailures,
  setConsecutiveFailures as setRetryCount,
  setSleeping,
} from "./transport/connection-state.ts";
export { enterSleepMode, MAX_CONNECTION_RETRIES } from "./transport/dormancy.ts";
export {
  DORMANT_RETRY_INTERVAL_MINUTES,
  KEEPALIVE_ALARM,
  KEEPALIVE_INTERVAL_MINUTES,
} from "./transport/keepalive.ts";

/** Parse one bridge frame and dispatch it to the handler for its request type. */
export async function route(raw: string): Promise<void> {
  let msg: BridgeMessage;
  try {
    msg = BridgeMessageSchema.parse(JSON.parse(raw));
  } catch {
    return;
  }
  if (msg.type === "read.request") {
    await handleRead(send, msg.id, {
      mode: msg.mode,
      offset: msg.offset,
      query: msg.query,
    });
  } else if (msg.type === "act.request") {
    await handleAct(send, msg);
  } else if (msg.type === "tabs.request") {
    await handleTabs(send, msg);
  }
}

/**
 * Connect the bridge, routing whatever it sends back through `route`.
 *
 * Which handler receives incoming frames is the worker's business, not the caller's, so it is bound
 * here rather than being a parameter every call site has to repeat.
 */
export function connect(options?: { readonly force?: boolean }): Promise<void> {
  return openBridgeConnection(route, options);
}

/**
 * Connect, unless the extension is dormant.
 *
 * The server binds its port only while a browser tool is in use, so "nothing is listening" is the
 * normal resting state rather than a fault. Reporting it through console.error would put a red
 * Errors badge on the extension card for a healthy install, so it is logged quietly and only
 * genuine failures are raised as errors.
 */
export function requestConnection(): void {
  if (isExtensionSleeping()) {
    return;
  }
  connect().catch(reportConnectionError);
}

/** Leave dormancy and reconnect immediately. Triggered by the toolbar and the popup. */
export async function wakeUp(): Promise<void> {
  await leaveSleepMode();
  await connect();
}

const chromeApi = typeof chrome === "undefined" ? undefined : chrome;

if (chromeApi?.runtime?.onInstalled) {
  chromeApi.runtime.onInstalled.addListener(() => requestConnection());
}
if (chromeApi?.runtime?.onStartup) {
  chromeApi.runtime.onStartup.addListener(() => requestConnection());
}

void scheduleKeepalive(KEEPALIVE_INTERVAL_MINUTES);

if (chromeApi?.alarms?.onAlarm) {
  chromeApi.alarms.onAlarm.addListener((alarm?: { name?: string }) => {
    if (alarm?.name && alarm.name !== KEEPALIVE_ALARM) {
      return;
    }
    if (isExtensionSleeping()) {
      // The single channel back from dormancy, rate-limited rather than trusting the alarm to fire
      // no faster than it was scheduled.
      const now = Date.now();
      if (!mayRetryWhileDormant(now, getLastDormantRetryAt())) {
        return;
      }
      setLastDormantRetryAt(now);
      void connect({ force: true }).catch(reportConnectionError);
      return;
    }
    requestConnection();
    void reportAccessStatus().catch(reportConnectionError);
  });
}

if (chromeApi?.action?.onClicked) {
  chromeApi.action.onClicked.addListener(() => {
    wakeUp().catch(reportConnectionError);
  });
}

if (chromeApi?.runtime?.onMessage) {
  chromeApi.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "wakeUp") {
      wakeUp().catch(reportConnectionError);
    }
  });
}

// Extension service workers reject top-level await even when the manifest declares an ESM worker.
// Start asynchronously so registration can finish before the first bridge connection attempt.
requestConnection();
