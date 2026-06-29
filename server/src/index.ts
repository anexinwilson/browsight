/**
 * Entry point. Loads the bridge config (port + token) written by `setup`, starts the loopback
 * bridge, and connects the MCP server to the client over stdio.
 *
 * Note: only JSON-RPC may go to stdout (the MCP channel); all logging goes to stderr.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startBridge } from "./bridge.ts";
import { createMcpServer } from "./mcp.ts";

interface BridgeConfig {
  readonly port: number;
  readonly token: string;
}

function loadConfig(): BridgeConfig {
  const path = join(homedir(), ".browsight", "bridge.json");
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as Partial<BridgeConfig>;
  if (typeof parsed.port !== "number" || typeof parsed.token !== "string") {
    throw new TypeError(`invalid bridge config at ${path} — run \`npm run setup\``);
  }
  return { port: parsed.port, token: parsed.token };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const bridge = startBridge(config);
  const server = createMcpServer(bridge);
  await server.connect(new StdioServerTransport());
}

try {
  await main();
} catch (err: unknown) {
  process.stderr.write(`browsight server failed to start: ${String(err)}\n`);
  process.exit(1);
}
