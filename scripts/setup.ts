#!/usr/bin/env node
import { spawnSync } from "node:child_process";
/**
 * `browsight setup`, the one-command bootstrap.
 *
 * Generates a token and a free loopback port, then shares them with both sides so the extension
 * auto-connects with no copy-paste: the server reads ~/.browsight/bridge.json, and the extension
 * reads extension/dist/connection.json (written into its own package). It also registers the MCP
 * server in the client config and prints the one manual step. `setup doctor` walks the chain and
 * reports the first broken link.
 *
 * Paths are rooted at $BROWSIGHT_HOME (defaults to the home directory) so the flow is testable.
 */
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";

export interface McpEntry {
  readonly command: string;
  readonly args: string[];
}

/** Generate a high-entropy per-install token. */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/** The MCP server entry that points the client at the built server. */
export function mcpServerEntry(serverEntryPath: string): McpEntry {
  return { command: process.execPath, args: [serverEntryPath] };
}

/** The MCP entry to write when running via npx, always re-fetches from the registry so the
 *  server is never tied to a temp cache path. */
export function mcpNpxEntry(): McpEntry {
  return { command: "npx", args: ["-y", "browsight", "serve"] };
}

/** Merge the browsight entry into a client config object without disturbing other servers. */
export function withBrowsightServer(
  config: Record<string, unknown>,
  entry: McpEntry,
): Record<string, unknown> {
  const existing = (config.mcpServers as Record<string, unknown> | undefined) ?? {};
  return { ...config, mcpServers: { ...existing, browsight: entry } };
}

const BACKSLASH_ESCAPED = String.raw`\\`;
const QUOTE_ESCAPED = String.raw`\"`;

/** Render a string as a TOML value. Literal (single-quoted) strings need no escaping, which keeps
 *  Windows paths like C:\Users\... intact; fall back to a basic string only if a quote appears. */
function tomlString(value: string): string {
  return value.includes("'")
    ? `"${value.replaceAll("\\", BACKSLASH_ESCAPED).replaceAll('"', QUOTE_ESCAPED)}"`
    : `'${value}'`;
}

/** The Codex `[mcp_servers.browsight]` table for the given entry. */
export function browsightCodexBlock(entry: McpEntry): string {
  const args = entry.args.map(tomlString).join(", ");
  return `[mcp_servers.browsight]\ncommand = ${tomlString(entry.command)}\nargs = [${args}]\n`;
}

/** Merge the browsight table into an existing config.toml (Codex's format), replacing a previous
 *  [mcp_servers.browsight] table in place and otherwise appending, so every other setting and MCP
 *  server in the file is preserved untouched. */
export function withBrowsightCodex(existing: string, entry: McpEntry): string {
  const block = browsightCodexBlock(entry);
  const header = /^\[mcp_servers\.browsight\][^\n]*$/m.exec(existing);
  if (header?.index === undefined) {
    const base = existing.trim();
    return base ? `${base}\n\n${block}` : block;
  }
  const after = existing.slice(header.index + header[0].length);
  const nextTable = after.search(/^[ \t]*\[/m);
  const tail = nextTable === -1 ? "" : after.slice(nextTable);
  const tailStr = tail ? `\n${tail}` : "";
  return `${existing.slice(0, header.index)}${block}${tailStr}`;
}

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
// When running source directly (node scripts/setup.ts): SCRIPT_DIR ends in /scripts
// When compiled by tsdown (scripts/dist/setup.mjs):     SCRIPT_DIR ends in /scripts/dist
// Detect which so PKG_ROOT always resolves to the package root correctly.
const isCompiled = /[/\\]dist$/.test(SCRIPT_DIR);
const PKG_ROOT = isCompiled ? resolve(SCRIPT_DIR, "..", "..") : resolve(SCRIPT_DIR, "..");

const SERVER_ENTRY = join(PKG_ROOT, "server", "dist", "index.mjs");
const EXTENSION_DIST_SRC = join(PKG_ROOT, "extension", "dist");

function home(): string {
  return process.env.BROWSIGHT_HOME ?? homedir();
}

/** True when running via `npx browsight`, the package is installed into the npm cache (_npx
 *  directory), not a permanent location, so we must copy the extension to ~/.browsight and use
 *  the npx command form in client configs rather than an absolute path to the cache. */
function isNpxContext(): boolean {
  // npx installs packages under a path containing _npx. A local repo clone never has this.
  const p = SCRIPT_DIR.replaceAll("\\", "/");
  return p.includes("/_npx/") || p.includes("/.cache/node/");
}

/** Permanent home for the extension on the user's machine. */
function extensionHome(): string {
  return join(home(), ".browsight", "extension");
}

function bridgeConfigPath(): string {
  return join(home(), ".browsight", "bridge.json");
}

/** JSON-config MCP clients to register browsight in. Claude Code is always set up; the others only
 *  if the client looks installed (its home folder exists), so setup never creates configs for apps
 *  that aren't there. Each entry is [id, configFile, installMarker]; Antigravity shares one config
 *  across its IDE/CLI at ~/.gemini/config/mcp_config.json. Codex is handled separately (it is TOML). */
function clientConfigPaths(): string[] {
  const h = home();
  const candidates: ReadonlyArray<readonly [string, string, string]> = [
    ["claude", join(h, ".claude.json"), join(h, ".claude")],
    ["cursor", join(h, ".cursor", "mcp.json"), join(h, ".cursor")],
    ["windsurf", join(h, ".codeium", "windsurf", "mcp_config.json"), join(h, ".codeium")],
    ["antigravity", join(h, ".gemini", "config", "mcp_config.json"), join(h, ".gemini")],
  ];
  return candidates
    .filter(([, p, marker]) => existsSync(p) || existsSync(marker))
    .map(([, p]) => p);
}

function codexConfigPath(): string {
  return join(home(), ".codex", "config.toml");
}

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

function writeJson(path: string, data: unknown): void {
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

export async function runSetup(options: { readonly newPort?: boolean } = {}): Promise<void> {
  const npx = isNpxContext();

  // Reuse the existing token + port if setup has run before, so re-running never moves the port out
  // from under a server that is already using it (the cause of ERR_CONNECTION_REFUSED on re-setup).
  const existing = readJson(bridgeConfigPath());
  const token = typeof existing.token === "string" ? existing.token : generateToken();
  let port: number;
  if (options.newPort) {
    port = await pickPort(0);
  } else if (typeof existing.port === "number") {
    port = existing.port;
  } else {
    port = await pickPort(8137);
  }
  const host = typeof existing.host === "string" ? existing.host : "127.0.0.1";

  writeSecretJson(bridgeConfigPath(), { host, port, token });

  // Always copy the bundled extension to a permanent ~/.browsight/extension/ folder
  // so Chrome can load it from a single stable path.
  const extensionDistPath = extensionHome();
  // Chrome keeps running the copy it loaded, so a re-run needs a reload rather than a fresh load.
  const alreadyLoaded = existsSync(join(extensionDistPath, "manifest.json"));
  mkdirSync(extensionDistPath, { recursive: true });
  if (existsSync(EXTENSION_DIST_SRC)) {
    cpSync(EXTENSION_DIST_SRC, extensionDistPath, { recursive: true });
  }

  writeSecretJson(join(extensionDistPath, "connection.json"), { host, port, token });

  // Write the correct MCP entry for this context.
  const entry = npx ? mcpNpxEntry() : mcpServerEntry(SERVER_ENTRY);

  for (const path of clientConfigPaths()) {
    writeJson(path, withBrowsightServer(readJson(path), entry));
  }
  // Codex uses TOML, not JSON, register it only if it looks installed, merging into any existing
  // config.toml so the user's other servers and settings are preserved.
  const codexPath = codexConfigPath();
  if (existsSync(codexPath) || existsSync(dirname(codexPath))) {
    const current = existsSync(codexPath) ? readFileSync(codexPath, "utf8") : "";
    mkdirSync(dirname(codexPath), { recursive: true });
    writeFileSync(codexPath, withBrowsightCodex(current, entry));
  }

  const lines = [
    "[ok] browsight is configured.",
    "",
    ...(alreadyLoaded
      ? [
          "Reload the extension so Chrome picks up this copy:",
          "  1. Chrome menu > Extensions > Manage extensions",
          "  2. click the reload icon on the Browsight card",
        ]
      : [
          "Load the extension into Chrome:",
          "  1. Chrome menu > Extensions > Manage extensions",
          "  2. enable Developer mode (top-right)",
          `  3. click "Load unpacked" and select:  ${extensionDistPath}`,
        ]),
    "",
    "Then restart your MCP client so it picks up the new configuration.",
    "Check the connection any time with `npx browsight doctor`.",
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

export function runDoctor(): void {
  const codexPath = codexConfigPath();
  const codexRegistered =
    existsSync(codexPath) && /^\[mcp_servers\.browsight\]/m.test(readFileSync(codexPath, "utf8"));
  const registered =
    codexRegistered ||
    clientConfigPaths().some(
      (p) => "browsight" in ((readJson(p).mcpServers as Record<string, unknown> | undefined) ?? {}),
    );
  const checks: ReadonlyArray<readonly [string, boolean]> = [
    ["server built (server/dist/index.mjs)", existsSync(SERVER_ENTRY)],
    [
      "extension built (extension/dist/manifest.json)",
      existsSync(join(EXTENSION_DIST_SRC, "manifest.json")) ||
        existsSync(join(extensionHome(), "manifest.json")),
    ],
    ["bridge config written (~/.browsight/bridge.json)", existsSync(bridgeConfigPath())],
    [
      "extension connection.json written",
      existsSync(join(EXTENSION_DIST_SRC, "connection.json")) ||
        existsSync(join(extensionHome(), "connection.json")),
    ],
    ["MCP server registered in a client config", registered],
  ];
  for (const [label, ok] of checks) {
    process.stdout.write(`${ok ? "[ok]" : "[missing]"} ${label}\n`);
  }
  const firstBroken = checks.find(([, ok]) => !ok);
  process.stdout.write(
    firstBroken
      ? `\nNext: fix "${firstBroken[0]}", run \`npx browsight setup\`.\n`
      : "\nAll links connected. If a read still fails, whitelist the site in the browsight popup.\n",
  );
}

export function runServe(args: readonly string[] = []): number {
  if (!existsSync(SERVER_ENTRY)) {
    process.stderr.write(
      "browsight server is not built; reinstall the package or run `npm run build`\n",
    );
    return 1;
  }
  const child = spawnSync(process.execPath, [SERVER_ENTRY, ...args], { stdio: "inherit" });
  if (child.error) {
    process.stderr.write(`browsight server failed: ${String(child.error)}\n`);
    return 1;
  }
  return child.status ?? 0;
}

export async function runCli(args: readonly string[]): Promise<number> {
  const [command, ...rest] = args;
  if (command === undefined || command === "setup") {
    await runSetup({ newPort: rest.includes("--new-port") });
    return 0;
  }
  if (command === "doctor") {
    runDoctor();
    return 0;
  }
  if (command === "serve") {
    return runServe(rest);
  }
  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(
      "browsight <command>\n\nCommands:\n  setup   Configure clients and install the extension (supports --new-port)\n  doctor  Check the local installation\n  serve   Start the MCP server (supports --idle-timeout <minutes>)\n",
    );
    return 0;
  }
  process.stderr.write(`unknown browsight command: ${command}\n`);
  return 1;
}

let isMain = false;
if (process.argv[1]) {
  try {
    isMain = realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    // Ignore symlink resolution errors
  }
}
if (isMain) {
  try {
    const exitCode = await runCli(process.argv.slice(2));
    if (exitCode !== 0) {
      process.exit(exitCode);
    }
  } catch (err: unknown) {
    const command = process.argv[2] ?? "setup";
    let errMsg = "Unknown error";
    if (err instanceof Error) {
      errMsg = err.message;
    } else if (typeof err === "string") {
      errMsg = err;
    } else {
      // String() would flatten a thrown object to "[object Object]".
      errMsg = inspect(err, { depth: 2 });
    }
    process.stderr.write(`${command} failed: ${errMsg}\n`);
    process.exit(1);
  }
}
