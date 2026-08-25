/**
 * The alarm that keeps the service worker reachable.
 *
 * Chrome suspends an idle service worker after about thirty seconds, so a periodic alarm is what
 * revives it to re-check the connection. Its interval is also how browsight throttles itself: while
 * dormant the alarm is slowed rather than cleared, because clearing it left a toolbar click as the
 * only way back, which stranded the first tool call after the server released its port.
 *
 * Rescheduling was written out three times with the same defensive try/catch; it lives here once.
 */

export const KEEPALIVE_ALARM = "browsight-keepalive";

/** Responsive interval, just under Chrome's suspension window. */
export const KEEPALIVE_INTERVAL_MINUTES = 0.4;

/**
 * Dormant interval. Chrome clamps alarms to a one-minute floor, so asking for less achieves nothing.
 */
export const DORMANT_RETRY_INTERVAL_MINUTES = 1;

/** Set the keepalive period. Ignores failures: a missing alarm must never break a connection. */
export async function scheduleKeepalive(periodInMinutes: number): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.alarms?.create) {
    return;
  }
  try {
    await chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes });
  } catch {
    // The worker still functions without the alarm; it simply revives less eagerly.
  }
}
