/**
 * How browsight is written into MCP client configuration: the entry shape, the JSON and TOML
 * writers and their inverses, and which clients are installed. Kept apart from the commands in
 * `setup.ts` so adding a client, or changing how an entry is written, touches one small file.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { browsightHome as home } from "@browsight/shared/paths";

export { home };

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

/** Strip the browsight entry from a JSON client config, leaving every other server untouched. */
export function withoutBrowsightServer(config: Record<string, unknown>): Record<string, unknown> {
  const existing = config.mcpServers as Record<string, unknown> | undefined;
  if (!existing || !("browsight" in existing)) {
    return config;
  }
  const { browsight: _removed, ...rest } = existing;
  return { ...config, mcpServers: rest };
}

/** Strip the [mcp_servers.browsight] table from a Codex config, leaving the rest of the file. */
export function withoutBrowsightCodex(existing: string): string {
  const header = /^\[mcp_servers\.browsight\][^\n]*$/m.exec(existing);
  if (header?.index === undefined) {
    return existing;
  }
  const after = existing.slice(header.index + header[0].length);
  const nextTable = after.search(/^[ \t]*\[/m);
  const tail = nextTable === -1 ? "" : after.slice(nextTable);
  return `${existing.slice(0, header.index)}${tail}`.trimEnd();
}

export const CLIENT_IDS = ["claude", "cursor", "windsurf", "antigravity", "codex"] as const;
export type ClientId = (typeof CLIENT_IDS)[number];

/** Read `--client=a,b` or `--client a,b`. Returns null when the flag is absent. */
export function parseClientFilter(args: readonly string[]): ClientId[] | null {
  const inline = args.find((a) => a.startsWith("--client="));
  const flagIndex = args.indexOf("--client");
  const raw =
    inline?.slice("--client=".length) ?? (flagIndex >= 0 ? args[flagIndex + 1] : undefined);
  if (raw === undefined) {
    return null;
  }
  const wanted = raw
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  const unknown = wanted.filter((name) => !CLIENT_IDS.includes(name as ClientId));
  if (unknown.length > 0) {
    throw new TypeError(`unknown client: ${unknown.join(", ")}. Known: ${CLIENT_IDS.join(", ")}`);
  }
  return wanted as ClientId[];
}

/** JSON-config MCP clients to register browsight in, as [id, path] pairs. A client is offered only
 *  if it looks installed (its config or home folder exists), so setup never creates configs for
 *  apps that aren't there. Antigravity shares one config across its IDE/CLI. Codex is handled
 *  separately because it is TOML. */
export function detectedClients(): Array<readonly [ClientId, string]> {
  const h = home();
  const candidates: ReadonlyArray<readonly [ClientId, string, string]> = [
    ["claude", join(h, ".claude.json"), join(h, ".claude")],
    ["cursor", join(h, ".cursor", "mcp.json"), join(h, ".cursor")],
    ["windsurf", join(h, ".codeium", "windsurf", "mcp_config.json"), join(h, ".codeium")],
    ["antigravity", join(h, ".gemini", "config", "mcp_config.json"), join(h, ".gemini")],
  ];
  return candidates
    .filter(([, p, marker]) => existsSync(p) || existsSync(marker))
    .map(([id, p]) => [id, p] as const);
}

export function clientConfigPaths(only?: ClientId[] | null): string[] {
  return detectedClients()
    .filter(([id]) => !only || only.includes(id))
    .map(([, p]) => p);
}

export function codexConfigPath(): string {
  return join(home(), ".codex", "config.toml");
}
