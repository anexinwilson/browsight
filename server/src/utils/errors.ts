/**
 * Reading the bits of a Node error that matter, without asserting a type onto an `unknown` catch
 * value. `EADDRINUSE` and `ESRCH` drive real decisions here, so the check is worth doing once.
 */

/** The `code` of a Node system error, or undefined when the value carries none. */
export function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const { code } = error as { code?: unknown };
  return typeof code === "string" ? code : undefined;
}
