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
import { createIdleController, parseIdleTimeoutMinutes } from "./idle.ts";
import { createMcpServer } from "./mcp.ts";

interface BridgeConfig {
  readonly port: number;
  readonly token: string;
}

const BRIDGE_START_ATTEMPTS = 3;
const BRIDGE_RETRY_MS = 400;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function startConfiguredBridge(
  config: BridgeConfig,
  onAccessStatus: (activeGrantCount: number) => void,
) {
  let lastError: unknown;
  for (let attempt = 0; attempt < BRIDGE_START_ATTEMPTS; attempt++) {
    const bridge = startBridge({ ...config, onAccessStatus });
    try {
      await bridge.ready;
      return bridge;
    } catch (err: unknown) {
      lastError = err;
      await bridge.close().catch(() => {});
      if (!String(err).includes("only one client") || attempt === BRIDGE_START_ATTEMPTS - 1) {
        break;
      }
      await wait(BRIDGE_RETRY_MS);
    }
  }
  throw lastError;
}

function loadConfig(): BridgeConfig {
  const configHome = process.env.BROWSIGHT_HOME ?? homedir();
  const path = join(configHome, ".browsight", "bridge.json");
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as Partial<BridgeConfig>;
  if (typeof parsed.port !== "number" || typeof parsed.token !== "string") {
    throw new TypeError(`invalid bridge config at ${path} — run \`npm run setup\``);
  }
  return { port: parsed.port, token: parsed.token };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const idleMinutes = parseIdleTimeoutMinutes(process.argv.slice(2));
  let latestGrantCount: number | null = null;
  let updateAccessTimer: ((activeGrantCount: number) => void) | undefined;
  const bridge = await startConfiguredBridge(config, (activeGrantCount) => {
    latestGrantCount = activeGrantCount;
    updateAccessTimer?.(activeGrantCount);
  });
  let shuttingDown = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    idle?.stop();
    process.stderr.write(`browsight: ${reason}; shutting down\n`);
    await bridge.close();
    process.exit(0);
  };
  const idle = createIdleController(idleMinutes, () =>
    shutdown(`no active site grants for ${idleMinutes} minutes`),
  );
  updateAccessTimer = (activeGrantCount): void => {
    if (activeGrantCount > 0) {
      idle.stop();
    } else {
      idle.touch();
    }
  };
  if (latestGrantCount !== null) {
    updateAccessTimer(latestGrantCount);
  }
  const server = createMcpServer(bridge);
  server.server.onclose = () => {
    void shutdown("MCP connection closed");
  };
  process.stdin.once("end", () => {
    setTimeout(() => {
      void shutdown("MCP input closed");
    }, 250);
  });
  await server.connect(new StdioServerTransport());
}

try {
  await main();
} catch (err: unknown) {
  process.stderr.write(`browsight server failed to start: ${String(err)}\n`);
  process.exit(1);
}
