/**
 * Checking the bearer token on a bridge request.
 *
 * Compared with `timingSafeEqual` so a wrong token takes the same time to reject whatever it looks
 * like: a plain `===` leaks how much of a guess was correct, which is enough to recover a token one
 * byte at a time from a process running on the same machine.
 */
import { timingSafeEqual } from "node:crypto";
import type http from "node:http";

/**
 * Constant-time string comparison to prevent timing attacks on token validation.
 */
export function tokensMatch(a: string | undefined | null, b: string): boolean {
  if (!a) return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * Extracts the bearer token from the request headers.
 *
 * Headers only: a query-string token leaks into logs and `Referer`, and a body
 * token would let a cross-site form post authenticate.
 */
export function extractToken(req: http.IncomingMessage): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader?.toLowerCase().startsWith("bearer ")) {
    return authHeader.slice(7).trim();
  }

  const customHeader = req.headers["x-browsight-token"];
  if (typeof customHeader === "string") {
    return customHeader;
  }

  return null;
}
