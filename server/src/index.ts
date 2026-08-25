/**
 * Entry point. Loads the bridge config (port + token) written by `setup`, prepares the loopback
 * bridge, and connects the MCP server to the client over stdio.
 *
 * This file is deliberately only wiring: it runs on import, so anything with logic of its own lives
 * in a module that can be tested without starting a server. The retry policy is in
 * `bridge/start-with-retry.ts`, the teardown sequence in `lifecycle/shutdown.ts`, and reading the
 * config in `bridge/config.ts`.
 *
 * Note: only JSON-RPC may go to stdout (the MCP channel); all logging goes to stderr.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startBridge } from "./bridge/bridge.ts";
import { bridgeConfigPath, loadBridgeConnection } from "./bridge/config.ts";
import { createLazyBridge } from "./bridge/lazy-bridge.ts";
import { startBridgeWithRetry } from "./bridge/start-with-retry.ts";
import { createIdleController, parseIdleTimeoutMinutes } from "./lifecycle/idle.ts";
import { startParentWatchdog } from "./lifecycle/parent-watchdog.ts";
import { forgetServer, recordServer } from "./lifecycle/pidfile.ts";
import { createShutdown, installShutdownTriggers } from "./lifecycle/shutdown.ts";
import { createMcpServer } from "./mcp.ts";

async function main(): Promise<void> {
  // Recorded so `browsight stop` can terminate this process without hunting through the process
  // table. Removed again on shutdown.
  recordServer();
  const config = loadBridgeConnection();
  const idleMinutes = parseIdleTimeoutMinutes(process.argv.slice(2));

  let onGrantCountChanged: ((activeGrantCount: number) => void) | undefined;

  // Nothing binds until a browser tool is called, so an unused browsight in one MCP client never
  // blocks another client from starting.
  const bridge = createLazyBridge({
    options: {
      ...config,
      configPath: bridgeConfigPath(),
      onAccessStatus: (activeGrantCount) => onGrantCountChanged?.(activeGrantCount),
    },
    start: (options) => startBridgeWithRetry(options, startBridge),
    onRelease: (reason) => process.stderr.write(`browsight: released the port (${reason})\n`),
  });

  const shutdown = createShutdown({
    before: () => {
      forgetServer();
      watchdog.stop();
      idle.stop();
    },
    close: () => bridge.close(),
  });

  const watchdog = startParentWatchdog({
    onParentExit: (reason) => {
      void shutdown(reason ?? "Parent process terminated");
    },
  });

  // Going idle frees the port for another client instead of exiting: the MCP client owns this
  // process's lifetime, and the parent watchdog handles real teardown.
  const idle = createIdleController(idleMinutes, () =>
    bridge.release(`no active site grants for ${idleMinutes} minutes`),
  );
  onGrantCountChanged = (activeGrantCount) => {
    if (activeGrantCount > 0) {
      idle.stop();
    } else {
      idle.touch();
    }
  };

  const server = createMcpServer(bridge);
  server.server.onclose = () => {
    void shutdown("MCP connection closed");
  };
  installShutdownTriggers(shutdown);

  await server.connect(new StdioServerTransport());
}

try {
  await main();
} catch (err: unknown) {
  process.stderr.write(`browsight server failed to start: ${String(err)}\n`);
  process.exit(1);
}
