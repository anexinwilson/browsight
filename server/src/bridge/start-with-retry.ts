/**
 * Starting the bridge when another instance may be shutting down at the same moment.
 *
 * Two MCP clients can be launched together, or one restarted while the previous process is still
 * releasing its port. That shows up as "only one client can drive browsight", and it usually clears
 * within a few hundred milliseconds, so it is worth a short retry rather than failing the boot.
 *
 * Any other failure is returned immediately: a port we are not allowed to bind will not free itself,
 * and retrying only delays telling the user what is wrong.
 */
import type { Bridge, BridgeOptions } from "./bridge.ts";

const ATTEMPTS = 3;
const RETRY_MS = 400;

/** Recognises the one failure that is worth waiting out. */
function isPortContention(err: unknown): boolean {
  return String(err).includes("only one client");
}

export interface StartWithRetryOptions {
  readonly attempts?: number;
  readonly retryMs?: number;
  /** Injected so tests do not sit through real delays. */
  readonly wait?: (ms: number) => Promise<void>;
}

export async function startBridgeWithRetry(
  options: BridgeOptions,
  start: (options: BridgeOptions) => Bridge,
  { attempts = ATTEMPTS, retryMs = RETRY_MS, wait = defaultWait }: StartWithRetryOptions = {},
): Promise<Bridge> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const bridge = start(options);
    try {
      await bridge.ready;
      return bridge;
    } catch (err: unknown) {
      lastError = err;
      await bridge.close().catch(() => {});
      if (!isPortContention(err) || attempt === attempts - 1) {
        break;
      }
      await wait(retryMs);
    }
  }
  throw lastError;
}

function defaultWait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
