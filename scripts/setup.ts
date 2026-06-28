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
import { fileURLToPath } from "node:url";

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

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_ENTRY = join(REPO_ROOT, "server", "dist", "index.mjs");
const EXTENSION_DIST = join(REPO_ROOT, "extension", "dist");

function home(): string {
  return process.env.BROWSIGHT_HOME ?? homedir();
}

function bridgeConfigPath(): string {
  return join(home(), ".browsight", "bridge.json");
}

function clientConfigPath(): string {
  return join(home(), ".claude.json");
}

function pickPort(preferred: number): Promise<number> {
  return new Promise((resolvePort) => {
    const probe = (port: number, retry: boolean): void => {
      const srv = createServer();
      srv.once("error", () => (retry ? probe(0, false) : resolvePort(preferred)));
      srv.once("listening", () => {
        const addr = srv.address();
        const chosen = typeof addr === "object" && addr ? addr.port : preferred;
        srv.close(() => resolvePort(chosen));
      });
      srv.listen(port, "127.0.0.1");
    };
    probe(preferred, true);
  });
}

function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function runSetup(): Promise<void> {
  // Reuse the existing token + port if setup has run before, so re-running never moves the port out
  // from under a server that is already using it (the cause of ERR_CONNECTION_REFUSED on re-setup).
  const existing = readJson(bridgeConfigPath());
  const token = typeof existing.token === "string" ? existing.token : generateToken();
  const port = typeof existing.port === "number" ? existing.port : await pickPort(8137);

  writeJson(bridgeConfigPath(), { port, token });
  writeJson(join(EXTENSION_DIST, "connection.json"), { port, token });
  writeJson(
    clientConfigPath(),
    withBrowsightServer(readJson(clientConfigPath()), mcpServerEntry(SERVER_ENTRY)),
  );

  const lines = [
    "✓ browsight is configured.",
    existsSync(SERVER_ENTRY) ? "" : "⚠ server not built yet — run `npm run build` first.",
    "",
    "Load the extension into Chrome (one time):",
    "  1. open chrome://extensions",
    "  2. enable Developer mode (top-right)",
    `  3. click \"Load unpacked\" and select:  ${EXTENSION_DIST}`,
    "",
    "Then restart your MCP client. Check the connection any time with `npm run doctor`.",
  ].filter((l) => l !== "");
  process.stdout.write(`${lines.join("\n")}\n`);
}

function runDoctor(): void {
  const clientServers =
    (readJson(clientConfigPath()).mcpServers as Record<string, unknown> | undefined) ?? {};
  const checks: ReadonlyArray<readonly [string, boolean]> = [
    ["server built (server/dist/index.mjs)", existsSync(SERVER_ENTRY)],
    [
      "extension built (extension/dist/manifest.json)",
      existsSync(join(EXTENSION_DIST, "manifest.json")),
    ],
    ["bridge config written (~/.browsight/bridge.json)", existsSync(bridgeConfigPath())],
    ["extension connection.json written", existsSync(join(EXTENSION_DIST, "connection.json"))],
    ["MCP server registered in client config", "browsight" in clientServers],
  ];
  for (const [label, ok] of checks) {
    process.stdout.write(`${ok ? "✓" : "✗"} ${label}\n`);
  }
  const firstBroken = checks.find(([, ok]) => !ok);
  process.stdout.write(
    firstBroken
      ? `\nNext: fix \"${firstBroken[0]}\" — run \`npm run build\` then \`npm run setup\`.\n`
      : "\nAll links connected. If a read still fails, whitelist the site in the browsight popup.\n",
  );
}

const isDoctor = process.argv.slice(2).includes("doctor");
const run = isDoctor ? Promise.resolve(runDoctor()) : runSetup();
run.catch((err: unknown) => {
  process.stderr.write(`setup failed: ${String(err)}\n`);
  process.exit(1);
});
