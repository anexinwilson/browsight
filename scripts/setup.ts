#!/usr/bin/env node
/**
 * `browsight setup` — the one-command bootstrap.
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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
 *  [mcp_servers.browsight] table in place and otherwise appending — so every other setting and MCP
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

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_ENTRY = join(REPO_ROOT, "server", "dist", "index.mjs");
const EXTENSION_DIST = join(REPO_ROOT, "extension", "dist");

function home(): string {
  return process.env.BROWSIGHT_HOME ?? homedir();
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
    ["claude", join(h, ".claude.json"), h],
    ["cursor", join(h, ".cursor", "mcp.json"), join(h, ".cursor")],
    ["windsurf", join(h, ".codeium", "windsurf", "mcp_config.json"), join(h, ".codeium")],
    ["antigravity", join(h, ".gemini", "config", "mcp_config.json"), join(h, ".gemini")],
  ];
  return candidates
    .filter(([id, p, marker]) => id === "claude" || existsSync(p) || existsSync(marker))
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

export async function runSetup(): Promise<void> {
  // Reuse the existing token + port if setup has run before, so re-running never moves the port out
  // from under a server that is already using it (the cause of ERR_CONNECTION_REFUSED on re-setup).
  const existing = readJson(bridgeConfigPath());
  const token = typeof existing.token === "string" ? existing.token : generateToken();
  const port = typeof existing.port === "number" ? existing.port : await pickPort(8137);

  const host = typeof existing.host === "string" ? existing.host : "127.0.0.1";

  writeJson(bridgeConfigPath(), { host, port, token });
  writeJson(join(EXTENSION_DIST, "connection.json"), { host, port, token });
  const entry = mcpServerEntry(SERVER_ENTRY);
  for (const path of clientConfigPaths()) {
    writeJson(path, withBrowsightServer(readJson(path), entry));
  }
  // Codex uses TOML, not JSON — register it only if it looks installed, merging into any existing
  // config.toml so the user's other servers and settings are preserved.
  const codexPath = codexConfigPath();
  if (existsSync(codexPath) || existsSync(dirname(codexPath))) {
    const current = existsSync(codexPath) ? readFileSync(codexPath, "utf8") : "";
    mkdirSync(dirname(codexPath), { recursive: true });
    writeFileSync(codexPath, withBrowsightCodex(current, entry));
  }

  const lines = [
    "✓ browsight is configured.",
    existsSync(SERVER_ENTRY) ? "" : "⚠ server not built yet — run `npm run build` first.",
    "",
    "Load the extension into Chrome (one time):",
    "  1. open chrome://extensions",
    "  2. enable Developer mode (top-right)",
    `  3. click "Load unpacked" and select:  ${EXTENSION_DIST}`,
    "",
    "Then restart your MCP client. Check the connection any time with `npm run doctor`.",
  ].filter((l) => l !== "");
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
      existsSync(join(EXTENSION_DIST, "manifest.json")),
    ],
    ["bridge config written (~/.browsight/bridge.json)", existsSync(bridgeConfigPath())],
    ["extension connection.json written", existsSync(join(EXTENSION_DIST, "connection.json"))],
    ["MCP server registered in a client config", registered],
  ];
  for (const [label, ok] of checks) {
    process.stdout.write(`${ok ? "✓" : "✗"} ${label}\n`);
  }
  const firstBroken = checks.find(([, ok]) => !ok);
  process.stdout.write(
    firstBroken
      ? `\nNext: fix "${firstBroken[0]}" — run \`npm run build\` then \`npm run setup\`.\n`
      : "\nAll links connected. If a read still fails, whitelist the site in the browsight popup.\n",
  );
}

const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (isMain) {
  const isDoctor = process.argv.slice(2).includes("doctor");
  if (isDoctor) {
    runDoctor();
  } else {
    try {
      await runSetup();
    } catch (err: unknown) {
      process.stderr.write(`setup failed: ${String(err)}\n`);
      process.exit(1);
    }
  }
}
