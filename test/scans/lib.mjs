/** Shared config and token loading for the scan scripts in this folder. */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const SONAR_PROJECT_KEY = "anexinwilson_browsight";
export const SONAR_ORGANIZATION = "anexinwilson";

/** Reads a token from the environment, falling back to the repo-root `.env`. */
export function readToken(name) {
  if (process.env[name]) return process.env[name];
  const envPath = join(REPO_ROOT, ".env");
  if (!existsSync(envPath)) return undefined;
  const match = new RegExp(`^${name}=(.*)$`, "m").exec(readFileSync(envPath, "utf8"));
  return match ? match[1].trim() : undefined;
}

export function requireToken(name) {
  const token = readToken(name);
  if (!token) {
    console.error(
      `Error: ${name} not found. Set it in the environment or in .env at the repo root.`,
    );
    console.error("See test/README.md for how to obtain one.");
    process.exit(1);
  }
  return token;
}

export const IS_WINDOWS = process.platform === "win32";
