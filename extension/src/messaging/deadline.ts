/**
 * Putting a bound on anything that talks to a tab.
 *
 * A content script can be injected into a page that never finishes loading, a navigation can stall,
 * and `chrome.tabs.sendMessage` can wait on a worker Chrome has suspended. None of those reject on
 * their own, so without a deadline a single tool call hangs until the MCP client gives up, with
 * nothing to say which step stalled.
 *
 * `stage` is carried on the error precisely so the caller can say which one it was.
 */

export class ActionTimeoutError extends Error {
  readonly stage: string;
  readonly timeoutMs: number;

  constructor(stage: string, timeoutMs: number) {
    super(`${stage} timed out after ${timeoutMs} ms`);
    this.name = "ActionTimeoutError";
    this.stage = stage;
    this.timeoutMs = timeoutMs;
  }
}

export async function withDeadline<T>(
  promise: Promise<T>,
  stage: string,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ActionTimeoutError(stage, timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
