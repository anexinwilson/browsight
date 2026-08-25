/**
 * Server-side post-processing: remove secrets from extracted text, estimate token cost, and
 * decide whether a page is a login wall. All pure functions, unit-tested against fixtures, they
 * touch no I/O so they are the easiest and most valuable part of the pipeline to test.
 */

// Match the tag first and inspect its type separately to avoid an expensive nested expression.
const INPUT_TAG = /<input\b[^>]+>/gi;
const PASSWORD_TYPE = /\btype=["']password["']/i;
const VALUE_ATTR = /\bvalue="[^"]*"|\bvalue='[^']*'/gi;
const BEARER = /\bBearer[ \t]+[a-z0-9._-]+/gi;
// Common secret shapes: Stripe/OpenAI-style keys (hyphen or underscore), GitHub tokens, AWS access
// keys, Slack tokens, Google API keys, and JWTs.
const KEY_PATTERNS = [
  /\b(?:sk|pk|rk)[-_]\w{12,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[\w-]{35}\b/g,
  /\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g,
];

/** Strip password-field values and common key/token shapes so secrets never reach the model. */
export function stripSecrets(input: string): string {
  let out = input;
  // Check password type in code after matching each input tag.
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

// Most walls no longer show a password box at all, they offer federated sign-in only.
// Requiring a password field made those pages read as ordinary content.
const OAUTH_HINTS = [
  /continue with (google|apple|facebook|github|microsoft|email)/i,
  /sign (in|up) with (google|apple|facebook|github|microsoft|sso)/i,
  /log in with (google|apple|facebook|github|microsoft)/i,
];

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
  const text = `${signals.title}\n${signals.text}`;
  // The size cap does the heavy lifting: an authenticated page is far larger than one
  // whose entire content is the sign-in prompt, so a "Sign in" link in shared navigation
  // never trips this.
  if (text.length > MAX_LOGIN_WALL_CHARS) {
    return false;
  }
  const hasFederatedButton = OAUTH_HINTS.some((re) => re.test(text));
  if (!signals.hasPasswordField && !hasFederatedButton) {
    return false;
  }
  return hasFederatedButton || LOGIN_HINTS.some((re) => re.test(text));
}
