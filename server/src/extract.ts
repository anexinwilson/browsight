/**
 * Server-side post-processing: remove secrets from extracted text, estimate token cost, and
 * decide whether a page is a login wall. All pure functions, unit-tested against fixtures — they
 * touch no I/O so they are the easiest and most valuable part of the pipeline to test.
 */

const PASSWORD_INPUT = /<input\b[^>]*\btype=["']password["'][^>]*>/gi;
const VALUE_ATTR = /\bvalue=["'][^"']*["']/i;
const API_KEY = /\b(?:sk|pk|rk)-[A-Za-z0-9]{12,}\b/g;
const GITHUB_TOKEN = /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._-]+/gi;

/** Strip password-field values and obvious key/token shapes so secrets never reach the model. */
export function stripSecrets(input: string): string {
  let out = input;
  out = out.replace(PASSWORD_INPUT, (tag) => tag.replace(VALUE_ATTR, 'value="[stripped]"'));
  out = out.replace(API_KEY, "[secret]");
  out = out.replace(GITHUB_TOKEN, "[secret]");
  out = out.replace(BEARER, "Bearer [secret]");
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
