/**
 * Where browsight's files live on this machine, and the small filesystem helpers the commands share.
 * Paths differ between running from source and running the published package, so they are resolved
 * once here rather than guessed at each call site.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Re-exported so the commands import every path from one module, while the paths themselves stay
// defined once in the shared package.
export { bridgeConfigPath, extensionHome } from "@browsight/shared/paths";

export const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
// When running source directly (node scripts/setup.ts): SCRIPT_DIR ends in /scripts
// When compiled by tsdown (scripts/dist/setup.mjs):     SCRIPT_DIR ends in /scripts/dist
// Detect which so PKG_ROOT always resolves to the package root correctly.
const isCompiled = /[/\\]dist$/.test(SCRIPT_DIR);
export const PKG_ROOT = isCompiled ? resolve(SCRIPT_DIR, "..", "..") : resolve(SCRIPT_DIR, "..");

export const SERVER_ENTRY = join(PKG_ROOT, "server", "dist", "index.mjs");
export const EXTENSION_DIST_SRC = join(PKG_ROOT, "extension", "dist");

/** True when running via `npx browsight`, the package is installed into the npm cache (_npx
 *  directory), not a permanent location, so we must copy the extension to ~/.browsight and use
 *  the npx command form in client configs rather than an absolute path to the cache. */
export function isNpxContext(): boolean {
  // npx installs packages under a path containing _npx. A local repo clone never has this.
  const p = SCRIPT_DIR.replaceAll("\\", "/");
  return p.includes("/_npx/") || p.includes("/.cache/node/");
}

/** Permanent home for the extension on the user's machine. */

/** JSON-config MCP clients to register browsight in. Claude Code is always set up; the others only
 *  if the client looks installed (its home folder exists), so setup never creates configs for apps
 *  that aren't there. Each entry is [id, configFile, installMarker]; Antigravity shares one config
 *  across its IDE/CLI at ~/.gemini/config/mcp_config.json. Codex is handled separately (it is TOML). */
export function tryPort(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.once("listening", () => {
      const addr = srv.address();
      const chosen = typeof addr === "object" && addr ? addr.port : port;
      srv.close(() => resolve(chosen));
    });
    srv.listen(port, "127.0.0.1");
  });
}

export async function pickPort(preferred: number): Promise<number> {
  try {
    return await tryPort(preferred);
  } catch {
    try {
      return await tryPort(0);
    } catch {
      return preferred;
    }
  }
}

export function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

/**
 * Writes a file that holds the bridge token, readable only by its owner.
 *
 * The token grants full control of the user's authenticated browser, and the
 * default file mode on macOS and Linux is world-readable, any other local account
 * could simply read it. The mode is applied explicitly as well as at creation,
 * because writeFileSync leaves the permissions of an existing file alone.
 * Windows ignores POSIX modes; there the user profile ACL already restricts access.
 */
export function writeSecretJson(path: string, data: unknown): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== "win32") {
    chmodSync(path, 0o600);
    try {
      chmodSync(dir, 0o700);
    } catch {
      // The directory may be shared (an extension bundle); the file mode is what matters.
    }
  }
}

export function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Write the browsight entry into the selected MCP clients. Every registered client spawns its own
 * browsight process, and browsight can drive a signed-in browser, so it registers where the user
 * asked rather than everywhere it can reach.
 */
