/**
 * The MCP surface. Registers the tools the client calls and turns bridge responses into
 * token-lean results: `browser_read` and `browser_act`.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Bridge } from "./bridge.ts";
import { estimateTokens, isLoginWall, stripSecrets } from "./extract.ts";

/** Build the MCP server, wiring `browser_read` and `browser_act` to the bridge. */
export function createMcpServer(bridge: Bridge): McpServer {
  const server = new McpServer({ name: "browsight", version: "0.0.0" });

  server.registerTool(
    "browser_read",
    {
      description:
        "Read the current Chrome tab as clean, structured context (markdown plus interactive references). Uses your real, logged-in session.",
      inputSchema: { url: z.string().optional() },
    },
    async ({ url }) => {
      const res = await bridge.readActiveTab(url ?? null);
      if (res.sentinel) {
        return { content: [{ type: "text" as const, text: `🔒 ${res.sentinel.hint}` }] };
      }
      if (isLoginWall({ title: "", text: res.markdown, hasPasswordField: res.hasPasswordField })) {
        return {
          content: [
            {
              type: "text" as const,
              text: "🔒 You appear to be signed out here — sign in, then ask me to read again.",
            },
          ],
        };
      }
      const body = stripSecrets(res.markdown);
      const header = `Token estimate: ~${estimateTokens(body)}`;
      return { content: [{ type: "text" as const, text: `${header}\n\n${body}` }] };
    },
  );

  server.registerTool(
    "browser_act",
    {
      description:
        "Perform one action on the current tab by reference (from a prior browser_read), then return a typed verdict and a diff of what changed.",
      inputSchema: {
        ref: z.string(),
        action: z.enum(["click", "fill", "navigate", "scroll"]),
        value: z.string().optional(),
      },
    },
    async ({ ref, action, value }) => {
      const res = await bridge.actActiveTab({
        ref,
        action,
        ...(value !== undefined ? { value } : {}),
      });
      if (res.sentinel) {
        return { content: [{ type: "text" as const, text: `⚠ ${res.sentinel.hint}` }] };
      }
      const changes = [
        res.diff.appeared.length > 0 ? `appeared: ${res.diff.appeared.join(", ")}` : "",
        res.diff.removed.length > 0 ? `removed: ${res.diff.removed.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("; ");
      const refsList = res.refs
        .map((r) => `[${r.role} ${JSON.stringify(r.name)} #${r.id}]`)
        .join("\n");
      const summary = changes ? `${res.verdict} — ${changes}` : res.verdict;
      return { content: [{ type: "text" as const, text: `${summary}\n\n${refsList}` }] };
    },
  );

  return server;
}
