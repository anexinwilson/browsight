import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  browsightCodexBlock,
  generateToken,
  mcpNpxEntry,
  mcpServerEntry,
  parseClientFilter,
  withBrowsightCodex,
  withBrowsightServer,
  withoutBrowsightCodex,
  withoutBrowsightServer,
} from "../../scripts/clients.ts";
import { output } from "../../scripts/output.ts";
import { pickPort, readJson, tryPort } from "../../scripts/paths.ts";
import { runDoctor, runSetup } from "../../scripts/setup.ts";
import { restoreArgv1 } from "./mock_helper.ts";

restoreArgv1();

/**
 * A stand-in for `extension/dist`, so tests never depend on a build having run. CI runs the test
 * step before `npm run build`, so anything reaching for real build output fails on a fresh checkout.
 */
function createFakeBuild(): string {
  const dir = mkdtempSync(join(scratchDir(), "fake_dist_"));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ name: "browsight" }));
  writeFileSync(join(dir, "content.js"), "// built content script");
  return dir;
}

/**
 * The scratch directory every temporary fixture lives under.
 *
 * It is gitignored, so it does not exist on a fresh checkout. Creating it here rather than at each
 * call site is what stops a fixture from assuming a directory that only exists on a machine where
 * the suite has run before.
 */
function scratchDir(): string {
  const dir = join(process.cwd(), "scratch");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function createTempHome(): string {
  return mkdtempSync(join(scratchDir(), "test_home_"));
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

  const originalWrite = output.write;
  let stdoutOutput = "";
  output.write = (chunk: string) => {
    stdoutOutput += chunk;
  };

  try {
    await runSetup();
  } finally {
    output.write = originalWrite;
    if (originalHome) {
      process.env.BROWSIGHT_HOME = originalHome;
    } else {
      process.env.BROWSIGHT_HOME = undefined;
    }
  }

  // Assertions
  assert.match(stdoutOutput, /\[ok\] browsight registered with/);

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

  const originalWrite = output.write;
  let stdoutOutput = "";
  output.write = (chunk: string) => {
    stdoutOutput += chunk;
  };

  try {
    runDoctor();
  } finally {
    output.write = originalWrite;
    if (originalHome) {
      process.env.BROWSIGHT_HOME = originalHome;
    } else {
      process.env.BROWSIGHT_HOME = undefined;
    }
  }

  // Assertions
  assert.match(stdoutOutput, /\[missing\] bridge config written/);
  assert.match(stdoutOutput, /Next: fix/);

  // Clean up
  rmSync(tempHome, { recursive: true, force: true });
});

test("runDoctor checks status of successful setup", async () => {
  const tempHome = createTempHome();
  const originalHome = process.env.BROWSIGHT_HOME;
  process.env.BROWSIGHT_HOME = tempHome;

  const originalWrite = output.write;
  let stdoutOutput = "";
  output.write = (chunk: string) => {
    stdoutOutput += chunk;
  };

  try {
    await runSetup();
    stdoutOutput = ""; // reset
    runDoctor();
  } finally {
    output.write = originalWrite;
    if (originalHome) {
      process.env.BROWSIGHT_HOME = originalHome;
    } else {
      process.env.BROWSIGHT_HOME = undefined;
    }
  }

  // Assertions
  assert.match(stdoutOutput, /\[ok\] bridge config written/);

  // Clean up
  rmSync(tempHome, { recursive: true, force: true });
});

test("pickPort secondary failure when both attempts reject", async () => {
  const require = createRequire(import.meta.url);
  const net = require("node:net");
  const originalCreateServer = net.createServer;
  net.createServer = () => {
    const srv = originalCreateServer();
    srv.listen = () => {
      process.nextTick(() => {
        srv.emit("error", new Error("mocked listen error"));
      });
      return srv;
    };
    return srv;
  };
  try {
    const port = await pickPort(1234);
    assert.equal(port, 1234);
  } finally {
    net.createServer = originalCreateServer;
  }
});

test("readJson recovery from malformed JSON", () => {
  const tempHome = createTempHome();
  const tempFile = join(tempHome, "malformed.json");
  writeFileSync(tempFile, "{invalid json}");
  const res = readJson(tempFile);
  assert.deepEqual(res, {});
  rmSync(tempHome, { recursive: true, force: true });
});

test("browsightCodexBlock quotes TOML paths and arguments safely", () => {
  // A value containing a single quote must use an escaped basic string.
  const block1 = browsightCodexBlock({
    command: "C:\\path'with'quote",
    args: [],
  });
  assert.match(block1, /command = "C:\\\\path'with'quote"/);

  // Double quotes can remain inside a TOML literal string.
  const block2 = browsightCodexBlock({
    command: "node",
    args: ['"double-quoted-arg"', 'arg"with"double'],
  });
  assert.match(block2, /args = \['"double-quoted-arg"', 'arg"with"double'\]/);
});

test("CLI entry point integration - setup and doctor execution", async () => {
  const tempHome = createTempHome();
  const REPO_ROOT = join(import.meta.dirname, "../..");

  // Run setup through its public CLI entry point.
  const childSetup = spawn(process.execPath, [join(REPO_ROOT, "scripts", "setup.ts")], {
    env: {
      ...process.env,
      USERPROFILE: tempHome,
      HOME: tempHome,
      BROWSIGHT_HOME: tempHome,
    },
  });

  const setupExit = await new Promise<number | null>((resolve) => {
    childSetup.on("close", resolve);
  });
  assert.equal(setupExit, 0);

  // Verify the doctor command against the setup output.
  const childDoctor = spawn(process.execPath, [join(REPO_ROOT, "scripts", "setup.ts"), "doctor"], {
    env: {
      ...process.env,
      USERPROFILE: tempHome,
      HOME: tempHome,
      BROWSIGHT_HOME: tempHome,
    },
  });

  let doctorStdout = "";
  childDoctor.stdout.on("data", (chunk) => {
    doctorStdout += chunk.toString();
  });

  const doctorExit = await new Promise<number | null>((resolve) => {
    childDoctor.on("close", resolve);
  });
  assert.equal(doctorExit, 0);
  assert.match(doctorStdout, /\[ok\] bridge config written/);

  rmSync(tempHome, { recursive: true, force: true });
});

test("mcpNpxEntry returns correct command structure", () => {
  const entry = mcpNpxEntry();
  assert.equal(entry.command, "npx");
  assert.deepEqual(entry.args, ["-y", "browsight", "serve"]);
});

test("tomlString fully escapes quotes and backslashes when single quotes are present", () => {
  const block = browsightCodexBlock({
    command: `C:\\path'with'quote"and"double\\quotes`,
    args: [],
  });
  // Must wrap in double quotes and escape all backslashes and double quotes
  assert.match(block, /command = "C:\\\\path'with'quote\\"and\\"double\\\\quotes"/);
});

test("withBrowsightCodex replaces stale browsight table when it is the last table (nextTable === -1)", () => {
  const existing = "[mcp_servers.browsight]\ncommand = 'old'\nargs = []\n";
  const merged = withBrowsightCodex(existing, { command: "new", args: ["s.mjs"] });
  assert.ok(merged.includes("command = 'new'"));
  assert.ok(!merged.includes("command = 'old'"));
  assert.ok(merged.endsWith("args = ['s.mjs']\n"));
});

test("withBrowsightCodex with empty base", () => {
  const merged = withBrowsightCodex("   ", { command: "node", args: ["s.mjs"] });
  assert.ok(merged.startsWith("[mcp_servers.browsight]"));
});

test("tryPort falls back to port argument if server address is not an object", async () => {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "./test/scripts/mock_helper.ts",
      "-e",
      "import { tryPort } from './scripts/paths.ts'; import assert from 'assert'; assert.equal(await tryPort(12345), 12345);",
    ],
    {
      env: {
        ...process.env,
        MOCK_SOCKET_ADDRESS: "string",
        IS_CHILD: "1",
      },
    },
  );

  const exitCode = await new Promise<number | null>((resolve) => {
    child.on("close", resolve);
  });

  assert.equal(exitCode, 0);
});

test("tryPort falls back to port argument if server address is null", async () => {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "./test/scripts/mock_helper.ts",
      "-e",
      "import { tryPort } from './scripts/paths.ts'; import assert from 'assert'; assert.equal(await tryPort(12345), 12345);",
    ],
    {
      env: {
        ...process.env,
        MOCK_SOCKET_ADDRESS: "null",
        IS_CHILD: "1",
      },
    },
  );

  const exitCode = await new Promise<number | null>((resolve) => {
    child.on("close", resolve);
  });

  assert.equal(exitCode, 0);
});

test("runSetup reuse of existing token, port, and host", async () => {
  const tempHome = createTempHome();
  const originalHome = process.env.BROWSIGHT_HOME;
  process.env.BROWSIGHT_HOME = tempHome;

  mkdirSync(join(tempHome, ".cursor"), { recursive: true });
  writeFileSync(join(tempHome, ".claude.json"), JSON.stringify({ mcpServers: {} }));

  const originalWrite = output.write;
  output.write = () => {};

  try {
    await runSetup();

    const bridge1 = JSON.parse(readFileSync(join(tempHome, ".browsight", "bridge.json"), "utf8"));
    assert.ok(bridge1.token);
    assert.ok(bridge1.port);

    await runSetup();

    const bridge2 = JSON.parse(readFileSync(join(tempHome, ".browsight", "bridge.json"), "utf8"));
    assert.equal(bridge2.token, bridge1.token);
    assert.equal(bridge2.port, bridge1.port);
    assert.equal(bridge2.host, bridge1.host);
  } finally {
    output.write = originalWrite;
    process.env.BROWSIGHT_HOME = originalHome;
    rmSync(tempHome, { recursive: true, force: true });
  }
});

test("runSetup can move a stale installation to a fresh port", async () => {
  const tempHome = createTempHome();
  const originalHome = process.env.BROWSIGHT_HOME;
  process.env.BROWSIGHT_HOME = tempHome;
  const configDir = join(tempHome, ".browsight");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "bridge.json"),
    JSON.stringify({ host: "127.0.0.1", port: 60928, token: "keep-this-token" }),
  );
  const originalWrite = output.write;
  output.write = () => {};
  try {
    await runSetup({ newPort: true });
    const updated = JSON.parse(readFileSync(join(configDir, "bridge.json"), "utf8"));
    assert.notEqual(updated.port, 60928);
    assert.equal(updated.token, "keep-this-token");
  } finally {
    output.write = originalWrite;
    process.env.BROWSIGHT_HOME = originalHome;
    rmSync(tempHome, { recursive: true, force: true });
  }
});

test("runSetup when client config file exists but its directory marker is also present", async () => {
  const tempHome = createTempHome();
  const originalHome = process.env.BROWSIGHT_HOME;
  process.env.BROWSIGHT_HOME = tempHome;

  mkdirSync(join(tempHome, ".cursor"), { recursive: true });
  writeFileSync(join(tempHome, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: {} }));

  const originalWrite = output.write;
  output.write = () => {};

  try {
    await runSetup();
    const cursorJson = JSON.parse(readFileSync(join(tempHome, ".cursor", "mcp.json"), "utf8"));
    assert.ok(cursorJson.mcpServers.browsight);
  } finally {
    output.write = originalWrite;
    process.env.BROWSIGHT_HOME = originalHome;
    rmSync(tempHome, { recursive: true, force: true });
  }
});

test("runSetup when Codex directory exists but config.toml does not", async () => {
  const tempHome = createTempHome();
  const originalHome = process.env.BROWSIGHT_HOME;
  process.env.BROWSIGHT_HOME = tempHome;

  mkdirSync(join(tempHome, ".codex"), { recursive: true });

  const originalWrite = output.write;
  output.write = () => {};

  try {
    await runSetup();
    const codexToml = readFileSync(join(tempHome, ".codex", "config.toml"), "utf8");
    assert.match(codexToml, /\[mcp_servers\.browsight\]/);
  } finally {
    output.write = originalWrite;
    process.env.BROWSIGHT_HOME = originalHome;
    rmSync(tempHome, { recursive: true, force: true });
  }
});

test("runDoctor checks status of configuration with only Codex registered", async () => {
  const tempHome = createTempHome();
  const originalHome = process.env.BROWSIGHT_HOME;
  process.env.BROWSIGHT_HOME = tempHome;

  mkdirSync(join(tempHome, ".codex"), { recursive: true });
  writeFileSync(
    join(tempHome, ".codex", "config.toml"),
    "[mcp_servers.browsight]\ncommand = 'node'\nargs = []\n",
  );

  const originalWrite = output.write;
  let stdoutOutput = "";
  output.write = (chunk: string) => {
    stdoutOutput += chunk;
  };

  try {
    runDoctor();
  } finally {
    output.write = originalWrite;
    process.env.BROWSIGHT_HOME = originalHome;
    rmSync(tempHome, { recursive: true, force: true });
  }

  assert.match(stdoutOutput, /\[ok\] MCP server registered in a client config/);
});

test("runDoctor when Codex config exists but is not registered", async () => {
  const tempHome = createTempHome();
  const originalHome = process.env.BROWSIGHT_HOME;
  process.env.BROWSIGHT_HOME = tempHome;

  mkdirSync(join(tempHome, ".codex"), { recursive: true });
  writeFileSync(join(tempHome, ".codex", "config.toml"), "[some_other_table]\nkey = 'value'\n");

  const originalWrite = output.write;
  let stdoutOutput = "";
  output.write = (chunk: string) => {
    stdoutOutput += chunk;
  };

  try {
    runDoctor();
  } finally {
    output.write = originalWrite;
    process.env.BROWSIGHT_HOME = originalHome;
    rmSync(tempHome, { recursive: true, force: true });
  }

  assert.match(stdoutOutput, /\[missing\] MCP server registered in a client config/);
});

test("runDoctor when client config exists but lacks mcpServers key", async () => {
  const tempHome = createTempHome();
  const originalHome = process.env.BROWSIGHT_HOME;
  process.env.BROWSIGHT_HOME = tempHome;

  mkdirSync(join(tempHome, ".cursor"), { recursive: true });
  writeFileSync(join(tempHome, ".claude.json"), JSON.stringify({}));

  const originalWrite = output.write;
  let stdoutOutput = "";
  output.write = (chunk: string) => {
    stdoutOutput += chunk;
  };

  try {
    runDoctor();
  } finally {
    output.write = originalWrite;
    process.env.BROWSIGHT_HOME = originalHome;
    rmSync(tempHome, { recursive: true, force: true });
  }

  assert.match(stdoutOutput, /\[missing\] MCP server registered in a client config/);
});

test("runDoctor secondary manifest and connection check when EXTENSION_DIST_SRC is missing", () => {
  const tempHome = createTempHome();
  const originalHome = process.env.BROWSIGHT_HOME;
  process.env.BROWSIGHT_HOME = tempHome;

  const extHome = join(tempHome, ".browsight", "extension");
  mkdirSync(extHome, { recursive: true });
  writeFileSync(join(extHome, "manifest.json"), "{}");
  writeFileSync(join(extHome, "connection.json"), "{}");

  mkdirSync(join(tempHome, ".browsight"), { recursive: true });
  writeFileSync(join(tempHome, ".browsight", "bridge.json"), "{}");

  mkdirSync(join(tempHome, ".codex"), { recursive: true });
  writeFileSync(
    join(tempHome, ".codex", "config.toml"),
    "[mcp_servers.browsight]\ncommand = 'node'\nargs = []\n",
  );

  const originalWrite = output.write;
  let stdoutOutput = "";
  output.write = (chunk: string) => {
    stdoutOutput += chunk;
  };

  // Temporarily rename the real extension/dist to force the secondary check
  const realDist = resolve("extension", "dist");
  const backupDist = resolve("extension", "dist_backup");
  const distExists = existsSync(realDist);

  if (distExists) {
    renameSync(realDist, backupDist);
  }

  try {
    runDoctor();
  } finally {
    output.write = originalWrite;
    process.env.BROWSIGHT_HOME = originalHome;
    if (distExists) {
      renameSync(backupDist, realDist);
    }
    rmSync(tempHome, { recursive: true, force: true });
  }

  assert.match(stdoutOutput, /\[ok\] extension built/);
  assert.match(stdoutOutput, /\[ok\] extension connection\.json written/);
});

test("runDoctor when extension build and connection files are completely missing", () => {
  const tempHome = createTempHome();
  const originalHome = process.env.BROWSIGHT_HOME;
  process.env.BROWSIGHT_HOME = tempHome;

  const originalWrite = output.write;
  let stdoutOutput = "";
  output.write = (chunk: string) => {
    stdoutOutput += chunk;
  };

  // Temporarily rename the real extension/dist
  const realDist = resolve("extension", "dist");
  const backupDist = resolve("extension", "dist_backup");
  const distExists = existsSync(realDist);
  if (distExists) {
    renameSync(realDist, backupDist);
  }

  try {
    runDoctor();
  } finally {
    output.write = originalWrite;
    process.env.BROWSIGHT_HOME = originalHome;
    if (distExists) {
      renameSync(backupDist, realDist);
    }
    rmSync(tempHome, { recursive: true, force: true });
  }

  assert.match(stdoutOutput, /\[missing\] extension built/);
  assert.match(stdoutOutput, /\[missing\] extension connection\.json written/);
});

test("runDoctor executes safely when BROWSIGHT_HOME is undefined", () => {
  const originalHome = process.env.BROWSIGHT_HOME;
  process.env.BROWSIGHT_HOME = undefined;
  delete process.env.BROWSIGHT_HOME;

  const originalWrite = output.write;
  let stdoutOutput = "";
  output.write = (chunk: string) => {
    stdoutOutput += chunk;
  };

  try {
    assert.doesNotThrow(() => {
      runDoctor();
    });
  } finally {
    output.write = originalWrite;
    process.env.BROWSIGHT_HOME = originalHome;
  }

  assert.match(stdoutOutput, /bridge\.json/);
  assert.match(stdoutOutput, /extension built/);
  assert.ok(stdoutOutput.includes("[ok]") || stdoutOutput.includes("[missing]"));
});

test("CLI entry point setup failure catch block", async () => {
  const tempHome = createTempHome();
  const REPO_ROOT = join(import.meta.dirname, "../..");

  mkdirSync(tempHome, { recursive: true });
  writeFileSync(join(tempHome, ".browsight"), "blocking file");

  const childSetup = spawn(process.execPath, [join(REPO_ROOT, "scripts", "setup.ts")], {
    env: {
      ...process.env,
      USERPROFILE: tempHome,
      HOME: tempHome,
      BROWSIGHT_HOME: tempHome,
    },
  });

  let stderrOutput = "";
  childSetup.stderr.on("data", (chunk) => {
    stderrOutput += chunk.toString();
  });

  const setupExit = await new Promise<number | null>((resolve) => {
    childSetup.on("close", resolve);
  });

  assert.equal(setupExit, 1);
  assert.match(stderrOutput, /setup failed:/);

  rmSync(tempHome, { recursive: true, force: true });
});

test("setup detects npx cache and compiled execution paths", async () => {
  const tempHome1 = createTempHome();
  const tempHome2 = createTempHome();
  const REPO_ROOT = join(import.meta.dirname, "../..");

  mkdirSync(join(tempHome1, ".codex"), { recursive: true });
  mkdirSync(join(tempHome2, ".codex"), { recursive: true });

  // Simulate execution from an npx cache path.
  const child1 = spawn(
    process.execPath,
    ["--import", "./test/scripts/mock_helper.ts", join(REPO_ROOT, "scripts", "setup.ts")],
    {
      env: {
        ...process.env,
        USERPROFILE: tempHome1,
        HOME: tempHome1,
        BROWSIGHT_HOME: tempHome1,
        IS_CHILD: "1",
      },
    },
  );

  const exitCode1 = await new Promise<number | null>((resolve) => {
    child1.on("close", resolve);
  });

  assert.equal(exitCode1, 0);

  // 2. Run simulating .cache/node
  const child2 = spawn(
    process.execPath,
    ["--import", "./test/scripts/mock_helper.ts", join(REPO_ROOT, "scripts", "setup.ts")],
    {
      env: {
        ...process.env,
        USERPROFILE: tempHome2,
        HOME: tempHome2,
        BROWSIGHT_HOME: tempHome2,
        MOCK_CACHE_NODE: "1",
        IS_CHILD: "1",
      },
    },
  );

  const exitCode2 = await new Promise<number | null>((resolve) => {
    child2.on("close", resolve);
  });

  assert.equal(exitCode2, 0);

  rmSync(tempHome1, { recursive: true, force: true });
  rmSync(tempHome2, { recursive: true, force: true });
});

test("token files are written owner-only", async () => {
  const { statSync } = await import("node:fs");
  const tempHome = createTempHome();
  const originalHome = process.env.BROWSIGHT_HOME;
  process.env.BROWSIGHT_HOME = tempHome;

  const originalWrite = output.write;
  output.write = () => {};
  try {
    await runSetup();
  } finally {
    output.write = originalWrite;
    process.env.BROWSIGHT_HOME = originalHome;
  }

  const bridgePath = join(tempHome, ".browsight", "bridge.json");
  const written = JSON.parse(readFileSync(bridgePath, "utf8"));
  assert.ok(written.token, "the file under test must actually hold a token");

  if (process.platform !== "win32") {
    // The bridge token grants full control of the user's authenticated browser, so
    // no other local account may read it. Default file modes are world-readable.
    const mode = statSync(bridgePath).mode & 0o777;
    assert.equal(mode, 0o600, `bridge.json must be owner-only, got ${mode.toString(8)}`);
  }

  rmSync(tempHome, { recursive: true, force: true });
});

test("--client narrows which MCP clients browsight registers with", () => {
  assert.deepStrictEqual(parseClientFilter([]), null, "no flag means no filter");
  assert.deepStrictEqual(parseClientFilter(["--client=claude"]), ["claude"]);
  assert.deepStrictEqual(parseClientFilter(["--client", "claude,cursor"]), ["claude", "cursor"]);
  assert.deepStrictEqual(parseClientFilter(["--client=Claude, Codex "]), ["claude", "codex"]);
  assert.throws(() => parseClientFilter(["--client=notaclient"]), /unknown client/);
});

test("stop removes browsight from client configs and leaves other servers alone", () => {
  const config = {
    mcpServers: { other: { command: "x" }, browsight: { command: "node" } },
    unrelated: true,
  };
  const stripped = withoutBrowsightServer(config as any) as any;
  assert.deepStrictEqual(Object.keys(stripped.mcpServers), ["other"]);
  assert.strictEqual(stripped.unrelated, true);
  // A config that never had browsight is returned untouched.
  const none = { mcpServers: { other: {} } };
  assert.strictEqual(withoutBrowsightServer(none as any), none);
});

test("stop removes the codex table and keeps the rest of the file", () => {
  const toml = [
    "[general]",
    'theme = "dark"',
    "",
    "[mcp_servers.browsight]",
    'command = "npx"',
    "",
    "[mcp_servers.other]",
    'command = "y"',
  ].join("\n");
  const stripped = withoutBrowsightCodex(toml);
  assert.ok(!stripped.includes("browsight"), "browsight table is gone");
  assert.ok(stripped.includes("[general]"), "other tables survive");
  assert.ok(stripped.includes("[mcp_servers.other]"), "other servers survive");
  assert.strictEqual(withoutBrowsightCodex("[general]"), "[general]");
});

test("build refreshes an existing install but never creates one", async (t) => {
  const { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } = await import(
    "node:fs"
  );
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const home = mkdtempSync(join(tmpdir(), "browsight-install-"));
  const previous = process.env.BROWSIGHT_HOME;
  process.env.BROWSIGHT_HOME = home;
  t.after(() => {
    if (previous === undefined) {
      delete process.env.BROWSIGHT_HOME;
    } else {
      process.env.BROWSIGHT_HOME = previous;
    }
  });

  const { isExtensionInstalled, refreshInstalledExtension, installExtension } = await import(
    "../../scripts/extension-install.ts"
  );
  const fakeBuild = createFakeBuild();

  // Nothing installed: building must not create files in a home directory.
  assert.equal(isExtensionInstalled(), false);
  assert.equal(refreshInstalledExtension(fakeBuild), false);
  assert.equal(existsSync(join(home, ".browsight", "extension", "manifest.json")), false);

  // Once installed, a build refreshes it, and the machine-specific secret survives.
  installExtension(fakeBuild);
  assert.equal(isExtensionInstalled(), true);
  const connection = join(home, ".browsight", "extension", "connection.json");
  mkdirSync(join(home, ".browsight", "extension"), { recursive: true });
  writeFileSync(connection, '{"port":1234}');
  assert.equal(refreshInstalledExtension(fakeBuild), true);
  assert.equal(readFileSync(connection, "utf8"), '{"port":1234}');
});

test("setup always shows the extension folder, on a first run and on a re-run", async () => {
  // Whether Chrome currently has the extension loaded is not knowable from here: the folder exists
  // either way. Guessing told users who had removed the extension to reload a card that was not
  // there, and never printed the path they needed to load it again.
  const tempHome = createTempHome();
  const originalHome = process.env.BROWSIGHT_HOME;
  process.env.BROWSIGHT_HOME = tempHome;

  const originalWrite = output.write;
  const runs: string[] = [];

  try {
    for (let run = 0; run < 2; run++) {
      let captured = "";
      output.write = (chunk: string) => {
        captured += chunk;
      };
      await runSetup();
      output.write = originalWrite;
      runs.push(captured);
    }
  } finally {
    output.write = originalWrite;
    if (originalHome) {
      process.env.BROWSIGHT_HOME = originalHome;
    } else {
      process.env.BROWSIGHT_HOME = undefined;
    }
  }

  const expectedFolder = join(tempHome, ".browsight", "extension");
  for (const [index, out] of runs.entries()) {
    const which = index === 0 ? "first run" : "re-run";
    assert.ok(out.includes(expectedFolder), `${which} must print the extension folder`);
    assert.match(out, /Load unpacked/, `${which} must say what to do with it`);
  }
});

test("a build newer than the install is reported as stale", async () => {
  // The failure that looks like nothing is wrong: the folder is there and the extension reloads,
  // but Chrome keeps running old code because the build never reached the install.
  const { utimesSync } = await import("node:fs");
  const tempHome = createTempHome();
  const originalHome = process.env.BROWSIGHT_HOME;
  process.env.BROWSIGHT_HOME = tempHome;

  const { installExtension, installedExtensionIsStale } = await import(
    "../../scripts/extension-install.ts"
  );
  const fakeBuild = createFakeBuild();

  try {
    // Nothing installed yet: there is no drift to report.
    assert.equal(installedExtensionIsStale(fakeBuild), false);

    installExtension(fakeBuild);
    assert.equal(installedExtensionIsStale(fakeBuild), false, "a fresh install is current");

    const future = new Date(Date.now() + 60_000);
    utimesSync(join(fakeBuild, "content.js"), future, future);
    assert.equal(installedExtensionIsStale(fakeBuild), true, "a newer build must read as stale");
  } finally {
    if (originalHome) {
      process.env.BROWSIGHT_HOME = originalHome;
    } else {
      process.env.BROWSIGHT_HOME = undefined;
    }
  }
});

test("doctor sends a stopped install to start, not setup", async () => {
  // `stop` promises browsight stays off until `start`. Pointing at `setup` would contradict it.
  const tempHome = createTempHome();
  const originalHome = process.env.BROWSIGHT_HOME;
  process.env.BROWSIGHT_HOME = tempHome;

  // Everything except registration must be healthy, so registration is the first broken link.
  const { installExtension } = await import("../../scripts/extension-install.ts");
  const fakeBuild = createFakeBuild();
  const fakeServerEntry = join(fakeBuild, "index.mjs");
  writeFileSync(fakeServerEntry, "// built server");
  installExtension(fakeBuild);
  mkdirSync(join(tempHome, ".browsight"), { recursive: true });
  const connection = JSON.stringify({ host: "127.0.0.1", port: 8137, token: "t" });
  writeFileSync(join(tempHome, ".browsight", "bridge.json"), connection);
  writeFileSync(join(tempHome, ".browsight", "extension", "connection.json"), connection);

  const originalWrite = output.write;
  let captured = "";
  try {
    output.write = (chunk: string) => {
      captured += chunk;
    };
    runDoctor({ serverEntry: fakeServerEntry, extensionDist: fakeBuild });
  } finally {
    output.write = originalWrite;
    if (originalHome) {
      process.env.BROWSIGHT_HOME = originalHome;
    } else {
      process.env.BROWSIGHT_HOME = undefined;
    }
  }

  assert.match(captured, /\[missing\] MCP server registered in a client config/);
  assert.match(captured, /run `npx browsight start`/);
});
