import assert from "node:assert/strict";
import { test } from "node:test";
import {
  browsightCodexBlock,
  generateToken,
  mcpServerEntry,
  withBrowsightCodex,
  withBrowsightServer,
} from "./setup.ts";

test("generateToken returns a long, unique token", () => {
  const a = generateToken();
  const b = generateToken();
  assert.notEqual(a, b);
  assert.ok(a.length >= 40);
});

test("mcpServerEntry points the client at the given server file", () => {
  const entry = mcpServerEntry("/abs/server/dist/index.mjs");
  assert.deepEqual(entry.args, ["/abs/server/dist/index.mjs"]);
  assert.ok(entry.command.length > 0);
});

test("withBrowsightServer adds browsight without disturbing other servers", () => {
  const config = { mcpServers: { other: { command: "x", args: [] } }, somethingElse: 1 };
  const merged = withBrowsightServer(config, { command: "node", args: ["s.mjs"] });
  const servers = merged.mcpServers as Record<string, unknown>;
  assert.ok("other" in servers, "existing server preserved");
  assert.ok("browsight" in servers, "browsight added");
  assert.equal(merged.somethingElse, 1, "unrelated keys preserved");
});

test("browsightCodexBlock writes a TOML table with literal-string paths", () => {
  const block = browsightCodexBlock({ command: "C:\\node.exe", args: ["C:\\index.mjs"] });
  assert.match(block, /^\[mcp_servers\.browsight\]$/m);
  assert.ok(block.includes("command = 'C:\\node.exe'"), "Windows path kept literal, not escaped");
  assert.ok(block.includes("args = ['C:\\index.mjs']"));
});

test("withBrowsightCodex appends to an existing config without touching other settings", () => {
  const existing = 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "x"\nargs = []\n';
  const merged = withBrowsightCodex(existing, { command: "node", args: ["s.mjs"] });
  assert.ok(merged.includes('model = "gpt-5"'), "top-level settings preserved");
  assert.ok(merged.includes("[mcp_servers.other]"), "other server preserved");
  assert.ok(merged.includes("[mcp_servers.browsight]"), "browsight added");
});

test("withBrowsightCodex replaces a stale browsight table in place", () => {
  const existing =
    "[mcp_servers.browsight]\ncommand = 'old'\nargs = []\n\n[mcp_servers.keep]\ncommand = 'y'\nargs = []\n";
  const merged = withBrowsightCodex(existing, { command: "new", args: ["s.mjs"] });
  assert.ok(merged.includes("command = 'new'"), "new command written");
  assert.ok(!merged.includes("command = 'old'"), "stale command removed");
  assert.ok(!/browsight[\s\S]*browsight/.test(merged), "no duplicate browsight table");
  assert.ok(merged.includes("[mcp_servers.keep]"), "later server preserved");
});
