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
import { bridgeConfigPath, startBridge } from "./bridge.ts";
import { createIdleController, parseIdleTimeoutMinutes } from "./idle.ts";
import { createLazyBridge } from "./lazy-bridge.ts";
import { createMcpServer } from "./mcp.ts";
import { startParentWatchdog } from "./parent-watchdog.ts";

interface BridgeConfig {
  readonly port: number;
  readonly token: string;
  readonly host?: string;
}

const BRIDGE_START_ATTEMPTS = 3;
const BRIDGE_RETRY_MS = 400;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function startConfiguredBridge(
  config: BridgeConfig & { configPath?: string },
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
    throw new TypeError(`invalid bridge config at ${path}, run \`npm run setup\``);
  }
  return {
    port: parsed.port,
    token: parsed.token,
    ...(typeof parsed.host === "string" ? { host: parsed.host } : {}),
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const idleMinutes = parseIdleTimeoutMinutes(process.argv.slice(2));
  let latestGrantCount: number | null = null;
  let updateAccessTimer: ((activeGrantCount: number) => void) | undefined;
  // Nothing binds until a browser tool is called, so an unused browsight in one
  // MCP client never blocks another client from starting.
  const bridge = createLazyBridge({
    options: {
      ...config,
      configPath: bridgeConfigPath(),
      onAccessStatus: (activeGrantCount) => {
        latestGrantCount = activeGrantCount;
        updateAccessTimer?.(activeGrantCount);
      },
    },
    start: (options) => startConfiguredBridge(options, options.onAccessStatus ?? (() => {})),
    onRelease: (reason) =>
      process.stderr.write(`browsight: released the port (${reason})
`),
  });
  let shuttingDown = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    watchdog?.stop();
    idle?.stop();

    // Fallback unref'd timer to force exit if bridge teardown hangs
    const forceExitTimer = setTimeout(() => {
      process.exit(0);
    }, 1000);
    forceExitTimer.unref();

    process.stderr.write(`browsight: ${reason}; shutting down\n`);
    try {
      await bridge.close();
    } catch {}
    process.exit(0);
  };

  const watchdog = startParentWatchdog({
    onParentExit: (reason) => {
      void shutdown(reason ?? "Parent process terminated");
    },
  });

  // Going idle frees the port for another client instead of exiting: the MCP client
  // owns this process's lifetime, and the parent watchdog handles real teardown.
  const idle = createIdleController(idleMinutes, () =>
    bridge.release(`no active site grants for ${idleMinutes} minutes`),
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

  // Stdio stream hooks
  process.stdin.once("end", () => {
    void shutdown("MCP stdin ended");
  });
  process.stdin.once("close", () => {
    void shutdown("MCP stdin closed");
  });
  process.stdin.on("error", () => {
    void shutdown("MCP stdin error");
  });
  process.stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") {
      void shutdown("MCP stdout pipe broken (EPIPE)");
    }
  });

  // Signal listeners
  process.on("SIGINT", () => {
    void shutdown("SIGINT received");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM received");
  });
  process.on("SIGHUP", () => {
    void shutdown("SIGHUP received");
  });
  if (process.platform === "win32") {
    process.on("SIGBREAK", () => {
      void shutdown("SIGBREAK received");
    });
  }

  await server.connect(new StdioServerTransport());
}

try {
  await main();
} catch (err: unknown) {
  process.stderr.write(`browsight server failed to start: ${String(err)}\n`);
  process.exit(1);
}
