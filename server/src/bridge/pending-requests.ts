/**
 * Correlating a request sent to the extension with the response that comes back.
 *
 * Every message the server sends carries an id, and the reply arrives later on a separate HTTP
 * request, so something has to hold the promise open in between and give up if no reply comes. That
 * bookkeeping — the map, the timers, and clearing both on every exit path — was previously spread
 * through the bridge's request, response, disconnect and close paths, where forgetting one meant a
 * leaked timer or a promise that never settles.
 *
 * Keeping it here means each exit path is one call, and the invariant that a settled request always
 * has its timer cleared and its entry removed is enforced in a single place.
 */
import type { BridgeMessage } from "@browsight/shared";

interface Pending {
  readonly resolve: (msg: BridgeMessage) => void;
  readonly reject: (err: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export interface PendingRequests {
  /** Hold a request open until its response arrives or `timeoutMs` passes. */
  track(
    id: string,
    timeoutMs: number,
    resolve: (msg: BridgeMessage) => void,
    reject: (err: Error) => void,
  ): void;
  /** Deliver a response. Returns false when nothing was waiting for it. */
  settle(id: string, message: BridgeMessage): boolean;
  /** Give up on one request, without rejecting it (the caller reports the failure). */
  forget(id: string): void;
  /** Fail everything still in flight, for a disconnect or a shutdown. */
  rejectAll(reason: string): void;
  readonly size: number;
}

export function createPendingRequests(): PendingRequests {
  const pending = new Map<string, Pending>();

  const take = (id: string): Pending | undefined => {
    const entry = pending.get(id);
    if (entry) {
      clearTimeout(entry.timer);
      pending.delete(id);
    }
    return entry;
  };

  return {
    track(id, timeoutMs, resolve, reject) {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("timed out waiting for the extension"));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
    },
    settle(id, message) {
      const entry = take(id);
      entry?.resolve(message);
      return entry !== undefined;
    },
    forget(id) {
      take(id);
    },
    rejectAll(reason) {
      // Collected before clearing so a reject handler that queues more work cannot mutate the map
      // mid-iteration.
      const abandoned = [...pending.values()];
      pending.clear();
      for (const entry of abandoned) {
        clearTimeout(entry.timer);
        entry.reject(new Error(reason));
      }
    },
    get size() {
      return pending.size;
    },
  };
}
