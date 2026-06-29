/**
 * The MCP surface. Registers the tools the client calls and turns bridge responses into
 * token-lean results: `browser_read`, `browser_act`, and `browser_tabs`.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Bridge } from "./bridge.ts";
import { estimateTokens, isLoginWall, stripSecrets } from "./extract.ts";
import { formatTabs } from "./tabs.ts";

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
      // The content script prepends a freshness marker (`<!-- page-load:N -->`); strip it for the
      // login-wall check so its extra characters can never push a borderline page past the detector's
      // length cap. The marker stays in the body below so the agent can still see it.
      const forDetection = res.markdown.replace(/^<!-- page-load:[^\n]*-->\n/, "");
      if (isLoginWall({ title: "", text: forDetection, hasPasswordField: res.hasPasswordField })) {
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
        "Perform one action on the current tab and return a typed verdict plus a diff of what changed. Pass a `ref` from a prior browser_read; `fill` takes its text in `value`, `navigate` takes a URL in `value`, and `scroll` takes `value` = `more` to load lazy content (pages down until comments, replies, or feed items appear, or the page bottoms out — use this to reveal comments / infinite feeds) or a direction (up/down/top/bottom) for manual paging.",
      inputSchema: {
        ref: z.string(),
        action: z.enum(["click", "fill", "navigate", "scroll"]),
        value: z
          .string()
          .optional()
          .describe(
            "Text for fill, a URL for navigate, or for scroll: `more` to load lazy content, or a direction (up/down/top/bottom).",
          ),
      },
    },
    async (req) => {
      const res = await bridge.actActiveTab({
        ref: req.ref,
        action: req.action,
        ...(req.value !== undefined ? { value: req.value } : {}),
      });
      if (res.sentinel) {
        return { content: [{ type: "text" as const, text: `⚠ ${res.sentinel.hint}` }] };
      }
      const changes = [
        res.diff.appeared.length > 0 ? `appeared: ${res.diff.appeared.join(", ")}` : "",
        res.diff.removed.length > 0 ? `removed: ${res.diff.removed.join(", ")}` : "",
        res.diff.changed.length > 0 ? `changed: ${res.diff.changed.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("; ");
      const refsList = res.refs
        .map((r) => `[${r.role} ${JSON.stringify(r.name)} #${r.id}]`)
        .join("\n");
      const summary = changes ? `${res.verdict} — ${changes}` : res.verdict;
      // Scrub secrets from the act output too, not just reads: ref names and diff entries are live
      // accessible names that can contain a token or key.
      return {
        content: [{ type: "text" as const, text: stripSecrets(`${summary}\n\n${refsList}`) }],
      };
    },
  );

  server.registerTool(
    "browser_tabs",
    {
      description:
        "List the open Chrome tabs and switch between them. With no argument, lists every open tab and whether each is allowed — browsight can only switch to and read sites the user has whitelisted; others are shown so you can ask the user to allow them. Pass `select` (a tab title, origin, or id) to switch to that tab and read it. If the chosen tab isn't whitelisted, the result tells the user to allow it in the popup. browser_read and browser_act always operate on the active tab, so use this to move focus between the user's allowed sites.",
      inputSchema: { select: z.string().optional() },
    },
    async ({ select }) => {
      const res = await bridge.listTabs(select ?? null);
      if (res.sentinel) {
        // Still show the list so the user can see what's open and which tab to whitelist.
        return {
          content: [
            { type: "text" as const, text: `⚠ ${res.sentinel.hint}\n\n${formatTabs(res.tabs)}` },
          ],
        };
      }
      if (res.switchedTo !== undefined && res.markdown !== undefined) {
        const body = stripSecrets(res.markdown);
        const header = `Switched to ${res.switchedTo}.\nToken estimate: ~${estimateTokens(body)}`;
        return { content: [{ type: "text" as const, text: `${header}\n\n${body}` }] };
      }
      return { content: [{ type: "text" as const, text: formatTabs(res.tabs) }] };
    },
  );

  return server;
}
