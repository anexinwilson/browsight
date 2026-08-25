/**
 * The service worker's connection state, and the one way to tear a connection down.
 *
 * A Chrome service worker is a singleton that Chrome may suspend and revive at will, so this state
 * is module-level by necessity. Keeping it here rather than in the worker's top level means the
 * pieces that read it — the dormancy policy, the client, the alarm handlers — depend on a named
 * module instead of on each other, and there is exactly one implementation of "is something already
 * connected" and "drop whatever is connected".
 */

let consecutiveFailures = 0;
let sleeping = false;
let connectionAttempt: Promise<void> | null = null;
let activeAbortController: AbortController | null = null;
let activeEventSource: EventSource | null = null;
/** Timestamp of the last dormant retry, so the retry rate never depends on Chrome's alarm timing. */
let lastDormantRetryAt = 0;

export function getConsecutiveFailures(): number {
  return consecutiveFailures;
}

export function setConsecutiveFailures(count: number): void {
  consecutiveFailures = count;
}

export function recordFailure(): number {
  consecutiveFailures += 1;
  return consecutiveFailures;
}

export function isExtensionSleeping(): boolean {
  return sleeping;
}

export function setSleeping(value: boolean): void {
  sleeping = value;
}

export function getLastDormantRetryAt(): number {
  return lastDormantRetryAt;
}

export function setLastDormantRetryAt(at: number): void {
  lastDormantRetryAt = at;
}

export function setActiveController(controller: AbortController | null): void {
  activeAbortController = controller;
}

export function getActiveController(): AbortController | null {
  return activeAbortController;
}

export function getConnectionAttempt(): Promise<void> | null {
  return connectionAttempt;
}

export function setConnectionAttempt(attempt: Promise<void> | null): void {
  connectionAttempt = attempt;
}

/**
 * Whether a usable connection already exists, so a second attempt would be wasted.
 *
 * An aborted controller does not count: it is the remains of a connection that has already gone.
 */
export function hasLiveConnection(): boolean {
  const controllerLive = activeAbortController !== null && !activeAbortController.signal.aborted;
  return controllerLive || activeEventSource !== null;
}

/** Drop the current connection and any attempt in flight. Safe to call when there is none. */
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
      // Already closed; dropping the reference is what matters.
    }
    activeEventSource = null;
  }
}
