/**
 * Server-side post-processing: remove secrets from extracted text, estimate token cost, and
 * decide whether a page is a login wall. All pure functions, unit-tested against fixtures — they
 * touch no I/O so they are the easiest and most valuable part of the pipeline to test.
 */

// S8786: Split into a simple tag-matcher (no nested quantifiers) + a code-level type check in
// stripSecrets, which eliminates the backtracking hazard from the original nested `[^>]*` groups.
const INPUT_TAG = /<input\b[^>]+>/gi;
const PASSWORD_TYPE = /\btype=["']password["']/i;
// S8786: Two explicit, non-overlapping alternatives instead of a mixed ["'] character class.
const VALUE_ATTR = /\bvalue="[^"]*"|\bvalue='[^']*'/gi;
// S8786: Use [ \t]+ instead of \s+ to avoid matching newlines and reduce backtracking surface.
const BEARER = /\bBearer[ \t]+[A-Za-z0-9._-]+/gi;
// Common secret shapes: Stripe/OpenAI-style keys (hyphen or underscore), GitHub tokens, AWS access
// keys, Slack tokens, Google API keys, and JWTs.
const KEY_PATTERNS = [
  /\b(?:sk|pk|rk)[-_][A-Za-z0-9_]{12,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
];

/** Strip password-field values and common key/token shapes so secrets never reach the model. */
export function stripSecrets(input: string): string {
  let out = input;
  // Two-step: first find any <input> tag, then check in code whether it is a password input.
  // This avoids nested quantifiers inside a single regex (S8786).
  out = out.replace(INPUT_TAG, (tag) =>
    PASSWORD_TYPE.test(tag) ? tag.replace(VALUE_ATTR, 'value="[stripped]"') : tag,
  );
  out = out.replace(BEARER, "Bearer [secret]");
  for (const re of KEY_PATTERNS) {
    out = out.replace(re, "[secret]");
  }
  return out;
}

/** Rough token estimate (~4 characters per token). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const LOGIN_HINTS = [/sign in/i, /log in/i, /enter your password/i, /forgot password/i];

// A genuine login wall is a short page dominated by the sign-in form. Authenticated pages are far
// larger, so this size cap separates them from a settings page that merely has a "change password"
// field or a "Sign in" link in shared nav.
const MAX_LOGIN_WALL_CHARS = 2000;

export interface LoginSignals {
  readonly title: string;
  readonly text: string;
  readonly hasPasswordField: boolean;
}

/** Decide whether a page is a login wall, given signals gathered in the content script. */
export function isLoginWall(signals: LoginSignals): boolean {
  if (!signals.hasPasswordField) {
    return false;
  }
  const text = `${signals.title}\n${signals.text}`;
  if (text.length > MAX_LOGIN_WALL_CHARS) {
    return false;
  }
  return LOGIN_HINTS.some((re) => re.test(text));
}
