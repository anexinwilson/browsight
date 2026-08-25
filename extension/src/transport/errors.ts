/**
 * Telling an expected condition apart from a real fault. The server binds its port only while a
 * tool is in use, so "nothing is listening" is the normal resting state; reporting it through
 * console.error puts a red Errors badge on the extension card for a perfectly healthy install.
 */

export function isServerNotListening(error: unknown): boolean {
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

export function reportConnectionError(error: unknown): void {
  if (isServerNotListening(error)) {
    console.debug("browsight: local server not listening (idle)", error);
    return;
  }
  console.error("browsight connection failed", error);
}
