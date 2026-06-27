/**
 * The MCP surface. Registers the tools the client calls and turns bridge responses into
 * token-lean results. Phase 1 ships `browser_read`; `browser_act` arrives in Phase 2.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Bridge } from "./bridge.ts";
import { estimateTokens, stripSecrets } from "./extract.ts";

/** Build the MCP server, wiring `browser_read` to the bridge. */
export function createMcpServer(bridge: Bridge): McpServer {
  const server = new McpServer({ name: "browsight", version: "0.0.0" });

  server.tool(
    "browser_read",
    "Read the current Chrome tab as clean, structured context (markdown plus interactive references). Uses your real, logged-in session.",
    { url: z.string().optional() },
    async ({ url }) => {
      const res = await bridge.readActiveTab(url ?? null);
      if (res.sentinel) {
        return { content: [{ type: "text" as const, text: `🔒 ${res.sentinel.hint}` }] };
      }
      const body = stripSecrets(res.markdown);
      const header = `Token estimate: ~${estimateTokens(body)}`;
      return { content: [{ type: "text" as const, text: `${header}\n\n${body}` }] };
    },
  );

  return server;
}
