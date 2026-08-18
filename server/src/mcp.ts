/**
 * The MCP surface. Registers the four tools the client calls and turns bridge responses into
 * token-lean results: `browser_status`, `browser_read`, `browser_act` and `browser_tabs`.
 */
import { statSync } from "node:fs";
import type { ActResponse } from "@browsight/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import pkg from "../package.json" with { type: "json" };
import type { Bridge } from "./bridge.ts";
import { estimateTokens, isLoginWall, stripSecrets } from "./extract.ts";
import { formatTabs } from "./tabs.ts";

const MAX_DIFF_ITEMS = 8;
const MAX_RESULT_REFS = 24;

function refKey(role: string, name: string): string {
  return `${role} ${JSON.stringify(name)}`;
}

function compactList(label: string, items: readonly string[]): string {
  if (items.length === 0) {
    return "";
  }
  const shown = items.slice(0, MAX_DIFF_ITEMS);
  const omitted = items.length - shown.length;
  const omittedSuffix = omitted > 0 ? ` (+${omitted} more)` : "";
  return `${label}: ${shown.join(", ")}${omittedSuffix}`;
}

function baseDiffKey(value: string): string {
  return value.replace(/ \(x\d+\)$/, "");
}

/** Numeric semver comparison so `0.9.0` sorts below `0.10.0`, which a string compare gets wrong. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff !== 0) {
      return diff < 0 ? -1 : 1;
    }
  }
  return 0;
}

export function formatActResponse(res: ActResponse): string {
  const changes = [
    compactList("appeared", res.diff.appeared),
    compactList("removed", res.diff.removed),
    compactList("changed", res.diff.changed),
  ]
    .filter(Boolean)
    .join("; ");
  const relevant = new Set(
    [...res.diff.appeared, ...res.diff.changed].map((item) => baseDiffKey(item)),
  );
  const matchingRefs = res.refs.filter((r) => relevant.has(refKey(r.role, r.name)));
  const refsList = matchingRefs
    .slice(0, MAX_RESULT_REFS)
    .map((r) => `[${r.role} ${JSON.stringify(r.name)} #${r.id}]`)
    .join("\n");
  const omittedRefs = matchingRefs.length - Math.min(matchingRefs.length, MAX_RESULT_REFS);
  const refsSuffix =
    omittedRefs > 0 ? `\n[${omittedRefs} additional changed controls omitted]` : "";
  const summary = changes ? `${res.verdict}: ${changes}` : res.verdict;
  const refsSection = refsList ? `\n\n${refsList}${refsSuffix}` : "";
  return stripSecrets(`${summary}${refsSection}`);
}

/**
 * A running server keeps the bundle it loaded at startup, so rebuilding on disk never reaches it and
 * it silently serves old code. Comparing the entry file's mtime against this process's start time
 * catches that, including rebuilds that do not change the version number.
 */
const PROCESS_STARTED_AT = Date.now();

export function isStaleBuild(entry = process.argv[1], startedAt = PROCESS_STARTED_AT): boolean {
  if (!entry) {
    return false;
  }
  try {
    return statSync(entry).mtimeMs > startedAt;
  } catch {
    return false;
  }
}

/** Build the MCP server, wiring `browser_read` and `browser_act` to the bridge. */
export function createMcpServer(bridge: Bridge, onActivity: () => void = () => {}): McpServer {
  const server = new McpServer({ name: "browsight", version: pkg.version });

  server.registerTool(
    "browser_status",
    {
      description:
        "Report whether browsight can actually drive Chrome right now, and why not if it cannot. Never fails, so call it when another browsight tool returns an error you do not understand. Reports the extension connection, the port in use, the extension and server versions (a mismatch means the extension needs reloading after an upgrade), and how many sites are currently whitelisted. Pass reload = true after running `browsight setup` to move this server onto the new port and token without restarting the MCP client.",
      inputSchema: { reload: z.boolean().optional() },
    },
    async ({ reload }) => {
      onActivity();
      const reloaded = reload ? await bridge.reloadConfig() : null;
      const s = bridge.status();
      const portDrift =
        s.configPort !== null && s.configPort !== s.port ? ` (config says ${s.configPort})` : "";
      const lines = [
        `extension: ${s.extensionConnected ? "connected" : "not connected"}`,
        `detail: ${s.detail}`,
        `bridge port: ${s.port}${portDrift}`,
        `server version: ${pkg.version}`,
        `extension version: ${s.extensionVersion ?? "unknown (not connected)"}`,
        `whitelisted sites active: ${s.activeGrants}`,
      ];
      if (isStaleBuild()) {
        lines.push(
          "WARNING: browsight has been rebuilt since this server started, so it is running old code. Restart your MCP client when convenient to pick it up.",
        );
      }
      if (s.extensionVersion && s.extensionVersion !== pkg.version) {
        // Whichever side is older is the one to restart. Always blaming the extension sends the
        // user to reload something that is already up to date.
        const extensionIsOlder = compareVersions(s.extensionVersion, pkg.version) < 0;
        lines.push(
          extensionIsOlder
            ? `WARNING: the extension is ${s.extensionVersion} and the server is ${pkg.version}, so reload the browsight extension from Chrome menu > Extensions > Manage extensions.`
            : `WARNING: the server is ${pkg.version} and the extension is ${s.extensionVersion}, so restart your MCP client to pick up the newer server.`,
        );
      }
      if (reloaded) {
        lines.push(`reload: ${reloaded.changed ? "applied" : "no change"}, ${reloaded.detail}`);
      }
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );

  server.registerTool(
    "browser_read",
    {
      description:
        "Read the current Chrome tab as clean, structured context (markdown plus interactive references). Uses your real, logged-in session. Use mode = main on dense applications to focus on the primary content region and reduce tokens; full remains the safe default.",
      inputSchema: {
        url: z.string().optional(),
        mode: z.enum(["full", "main"]).optional(),
      },
    },
    async ({ url, mode }) => {
      onActivity();
      const res = await bridge.readActiveTab(url ?? null, mode ?? "full");
      if (res.sentinel) {
        return { content: [{ type: "text" as const, text: res.sentinel.hint }] };
      }
      // The content script prepends a freshness marker (`<!-- page-load:N -->`); strip it for the
      // login-wall check so its extra characters can never push a borderline page past the detector's
      // length cap. The marker stays in the body below so the agent can still see it.
      const forDetection = res.markdown.replace(/^<!-- page-load:[^\n]*-->\n/, "");
      const signedOut = isLoginWall({
        title: "",
        text: forDetection,
        hasPasswordField: res.hasPasswordField,
      });
      const body = stripSecrets(res.markdown);
      const header = `Token estimate: ~${estimateTokens(body)}`;
      // A sign-in prompt is a note on the page, never a replacement for it. Sites routinely put a
      // dismissible modal over content that reads perfectly well, so withholding the body loses a
      // whole page of results and leaves the caller unable to close the prompt or scroll past it.
      const notice = signedOut
        ? "Note: a sign-in prompt is showing. Some content may be held back, and there may be a dialog to close." +
          "\n\n"
        : "";
      return { content: [{ type: "text" as const, text: `${notice}${header}\n\n${body}` }] };
    },
  );

  server.registerTool(
    "browser_act",
    {
      description:
        "Perform one action on the current tab and return a typed verdict plus a diff of what changed. Pass a `ref` from a prior browser_read; `fill` takes its text in `value`, `navigate` takes a URL in `value`, and `scroll` takes `value` = `more` to load lazy content (pages down until comments, replies, or feed items appear, or the page bottoms out, use this to reveal comments / infinite feeds) or a direction (up/down/top/bottom) for manual paging.",
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
      onActivity();
      const res = await bridge.actActiveTab({
        ref: req.ref,
        action: req.action,
        ...(req.value !== undefined ? { value: req.value } : {}),
      });
      if (res.sentinel) {
        return { content: [{ type: "text" as const, text: res.sentinel.hint }] };
      }
      // Scrub secrets from the act output too, not just reads: ref names and diff entries are live
      // accessible names that can contain a token or key.
      return {
        content: [{ type: "text" as const, text: formatActResponse(res) }],
      };
    },
  );

  server.registerTool(
    "browser_tabs",
    {
      description:
        "List the open Chrome tabs and switch between them. With no argument, lists every open tab and whether each is allowed, browsight can only switch to and read sites the user has whitelisted; others are shown so you can ask the user to allow them. Pass `select` (a tab title, origin, or id) to switch to that tab; add `read: true` to switch and read the page in one call, otherwise switching is cheap and you call browser_read when you want the content. If the chosen tab isn't whitelisted, the result tells the user to allow it in the popup. browser_read and browser_act always operate on the active tab, so use this to move focus between the user's allowed sites.",
      inputSchema: { select: z.string().optional(), read: z.boolean().optional() },
    },
    async ({ select, read }) => {
      onActivity();
      const res = await bridge.listTabs(select ?? null);
      if (res.sentinel) {
        // Still show the list so the user can see what's open and which tab to whitelist.
        return {
          content: [
            { type: "text" as const, text: `${res.sentinel.hint}\n\n${formatTabs(res.tabs)}` },
          ],
        };
      }
      if (res.switchedTo !== undefined) {
        // Changing focus should not cost a whole page read. Callers that want the
        // content ask for it, with read=true or a following browser_read.
        if (!read || res.markdown === undefined) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Switched to ${res.switchedTo}. Call browser_read for the page, or browser_tabs with read=true to switch and read in one step.`,
              },
            ],
          };
        }
        const body = stripSecrets(res.markdown);
        const header = `Switched to ${res.switchedTo}.\nToken estimate: ~${estimateTokens(body)}`;
        return { content: [{ type: "text" as const, text: `${header}\n\n${body}` }] };
      }
      return { content: [{ type: "text" as const, text: formatTabs(res.tabs) }] };
    },
  );

  return server;
}
