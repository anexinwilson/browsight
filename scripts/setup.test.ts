import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import {
  browsightCodexBlock,
  generateToken,
  mcpServerEntry,
  pickPort,
  runDoctor,
  runSetup,
  tryPort,
  withBrowsightCodex,
  withBrowsightServer,
} from "./setup.ts";

function createTempHome(): string {
  const scratchDir = join(process.cwd(), "scratch");
  mkdirSync(scratchDir, { recursive: true });
  return mkdtempSync(join(scratchDir, "test_home_"));
}

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

test("tryPort and pickPort behavior under port conflicts", async () => {
  // Test tryPort with a free port (0 asks OS to allocate a free port)
  const port = await tryPort(0);
  assert.ok(port > 0);

  // Test tryPort with a busy port
  const server = createServer();
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const busyPort = (server.address() as any).port;

  await assert.rejects(async () => {
    await tryPort(busyPort);
  });

  // Test pickPort when preferred port is free
  const freePort = await pickPort(0);
  assert.ok(freePort > 0);

  // Test pickPort when preferred port is busy (should fall back to another port)
  const fallbackPort = await pickPort(busyPort);
  assert.ok(fallbackPort > 0);
  assert.notEqual(fallbackPort, busyPort);

  server.close();
});

test("runSetup generates token/port and writes config files", async () => {
  const tempHome = createTempHome();
  const originalHome = process.env.BROWSIGHT_HOME;
  process.env.BROWSIGHT_HOME = tempHome;

  // Create folders so client config paths gets detected
  mkdirSync(join(tempHome, ".cursor"), { recursive: true });
  mkdirSync(join(tempHome, ".codeium"), { recursive: true });
  mkdirSync(join(tempHome, ".gemini"), { recursive: true });
  mkdirSync(join(tempHome, ".codex"), { recursive: true });

  // Write some dummy initial files to make sure they are merged
  writeFileSync(join(tempHome, ".claude.json"), JSON.stringify({ mcpServers: {} }));
  writeFileSync(join(tempHome, ".codex", "config.toml"), "initial = true\n");

  const originalWrite = process.stdout.write;
  let stdoutOutput = "";
  process.stdout.write = (chunk: any) => {
    stdoutOutput += chunk;
    return true;
  };

  try {
    await runSetup();
  } finally {
    process.stdout.write = originalWrite;
    if (originalHome) {
      process.env.BROWSIGHT_HOME = originalHome;
    } else {
      process.env.BROWSIGHT_HOME = undefined;
    }
  }

  // Assertions
  assert.match(stdoutOutput, /✓ browsight is configured/);

  // Check that bridge.json was written
  const bridgeJson = JSON.parse(readFileSync(join(tempHome, ".browsight", "bridge.json"), "utf8"));
  assert.ok(bridgeJson.token);
  assert.ok(bridgeJson.port);

  // Check client configs
  const claudeJson = JSON.parse(readFileSync(join(tempHome, ".claude.json"), "utf8"));
  assert.ok(claudeJson.mcpServers.browsight);

  const codexToml = readFileSync(join(tempHome, ".codex", "config.toml"), "utf8");
  assert.match(codexToml, /\[mcp_servers\.browsight\]/);
  assert.match(codexToml, /initial = true/);

  // Clean up
  rmSync(tempHome, { recursive: true, force: true });
});

test("runDoctor checks status of configuration", async () => {
  const tempHome = createTempHome();
  const originalHome = process.env.BROWSIGHT_HOME;
  process.env.BROWSIGHT_HOME = tempHome;

  const originalWrite = process.stdout.write;
  let stdoutOutput = "";
  process.stdout.write = (chunk: any) => {
    stdoutOutput += chunk;
    return true;
  };

  try {
    runDoctor();
  } finally {
    process.stdout.write = originalWrite;
    if (originalHome) {
      process.env.BROWSIGHT_HOME = originalHome;
    } else {
      process.env.BROWSIGHT_HOME = undefined;
    }
  }

  // Assertions
  assert.match(stdoutOutput, /✗ bridge config written/);
  assert.match(stdoutOutput, /Next: fix/);

  // Clean up
  rmSync(tempHome, { recursive: true, force: true });
});

test("runDoctor checks status of successful setup", async () => {
  const tempHome = createTempHome();
  const originalHome = process.env.BROWSIGHT_HOME;
  process.env.BROWSIGHT_HOME = tempHome;

  const originalWrite = process.stdout.write;
  let stdoutOutput = "";
  process.stdout.write = (chunk: any) => {
    stdoutOutput += chunk;
    return true;
  };

  try {
    await runSetup();
    stdoutOutput = ""; // reset
    runDoctor();
  } finally {
    process.stdout.write = originalWrite;
    if (originalHome) {
      process.env.BROWSIGHT_HOME = originalHome;
    } else {
      process.env.BROWSIGHT_HOME = undefined;
    }
  }

  // Assertions
  assert.match(stdoutOutput, /✓ bridge config written/);

  // Clean up
  rmSync(tempHome, { recursive: true, force: true });
});
