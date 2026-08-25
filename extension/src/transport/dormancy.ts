/**
 * Backing off when the server cannot be reached, and coming back when it can.
 *
 * The server binds its port only while a browser tool is in use, so finding nothing listening is
 * browsight's normal resting state rather than a fault. Counting that as a failure would push the
 * extension into dormancy simply for sitting idle, and it would then reconnect slowly once the
 * server did come back. Only genuine failures — a rejected token, a malformed reply, a missing
 * config — count towards going dormant.
 */
import { clearBadge, setSleepBadge } from "./badge.ts";
import {
  disconnect,
  isExtensionSleeping,
  recordFailure,
  setConsecutiveFailures,
  setLastDormantRetryAt,
  setSleeping,
} from "./connection-state.ts";
import { isServerNotListening, reportConnectionError } from "./errors.ts";
import {
  DORMANT_RETRY_INTERVAL_MINUTES,
  KEEPALIVE_INTERVAL_MINUTES,
  scheduleKeepalive,
} from "./keepalive.ts";

/** Consecutive genuine failures before the extension goes dormant. */
export const MAX_CONNECTION_RETRIES = 3;

/** Stop trying, slow the alarm, and show it on the toolbar. */
export async function enterSleepMode(): Promise<void> {
  setSleeping(true);
  disconnect();
  await scheduleKeepalive(DORMANT_RETRY_INTERVAL_MINUTES);
  await setSleepBadge();
  console.info("browsight: dormant after repeated connection failures; retrying slowly");
}

/** Clear dormancy and restore the responsive alarm. The caller reconnects. */
export async function leaveSleepMode(): Promise<void> {
  setLastDormantRetryAt(0);
  setConsecutiveFailures(0);
  setSleeping(false);
  disconnect();
  await clearBadge();
  await scheduleKeepalive(KEEPALIVE_INTERVAL_MINUTES);
}

/** Record a failed connection, going dormant once they stop looking incidental. */
export async function handleConnectionFailure(error?: unknown): Promise<void> {
  disconnect();
  if (isExtensionSleeping()) {
    return;
  }
  if (error) {
    reportConnectionError(error);
  }
  if (isServerNotListening(error)) {
    return;
  }
  if (recordFailure() >= MAX_CONNECTION_RETRIES) {
    await enterSleepMode();
  }
}

/**
 * Whether the dormant retry may run now.
 *
 * Rate-limited here rather than trusting the alarm to fire no faster than it was scheduled.
 */
export function mayRetryWhileDormant(now: number, lastRetryAt: number): boolean {
  return now - lastRetryAt >= DORMANT_RETRY_INTERVAL_MINUTES * 60_000;
}
