#!/usr/bin/env node
/**
 * The browsight CLI: `setup`, `start`, `stop`, `doctor` and `serve`.
 *
 * Setup is the only command that writes: it picks a port, writes the shared bridge config, installs
 * the extension where Chrome can load it, and registers browsight with whichever MCP clients are
 * present. The pieces it composes live alongside it, in `clients.ts`, `paths.ts` and
 * `extension-install.ts`, so this file stays the sequence rather than the mechanics.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { liveServerPids } from "../server/src/lifecycle/pidfile.ts";
import {
  type ClientId,
  clientConfigPaths,
  codexConfigPath,
  detectedClients,
  generateToken,
  type McpEntry,
  mcpNpxEntry,
  mcpServerEntry,
  parseClientFilter,
  withBrowsightCodex,
  withBrowsightServer,
  withoutBrowsightCodex,
  withoutBrowsightServer,
} from "./clients.ts";
import { installExtension, installedExtensionIsStale } from "./extension-install.ts";
import { output } from "./output.ts";
import {
  bridgeConfigPath,
  EXTENSION_DIST_SRC,
  extensionHome,
  isNpxContext,
  pickPort,
  readJson,
  SERVER_ENTRY,
  writeJson,
  writeSecretJson,
} from "./paths.ts";

function registerClients(
  entry: McpEntry,
  only: ClientId[] | null,
): { registered: ClientId[]; skipped: ClientId[] } {
  const registered: ClientId[] = [];
  const skipped: ClientId[] = [];
  const wanted = (id: ClientId) => !only || only.includes(id);

  for (const [id, path] of detectedClients()) {
    if (wanted(id)) {
      writeJson(path, withBrowsightServer(readJson(path), entry));
      registered.push(id);
    } else {
      skipped.push(id);
    }
  }

  // Codex uses TOML, not JSON. Merge into any existing config.toml so the user's other servers
  // and settings survive.
  const codexPath = codexConfigPath();
  if (!existsSync(codexPath) && !existsSync(dirname(codexPath))) {
    return { registered, skipped };
  }
  if (!wanted("codex")) {
    skipped.push("codex");
    return { registered, skipped };
  }
  const current = existsSync(codexPath) ? readFileSync(codexPath, "utf8") : "";
  mkdirSync(dirname(codexPath), { recursive: true });
  writeFileSync(codexPath, withBrowsightCodex(current, entry));
  registered.push("codex");
  return { registered, skipped };
}

/**
 * Turn browsight off. Removes it from every MCP client config so nothing spawns it again, then
 * terminates any server still running. It stays off until `browsight start`.
 */
export function runStop(): void {
  const removed: ClientId[] = [];
  for (const [id, path] of detectedClients()) {
    const before = readJson(path);
    const after = withoutBrowsightServer(before);
    if (after !== before) {
      writeJson(path, after);
      removed.push(id);
    }
  }
  const codexPath = codexConfigPath();
  if (existsSync(codexPath)) {
    const before = readFileSync(codexPath, "utf8");
    const after = withoutBrowsightCodex(before);
    if (after !== before) {
      writeFileSync(codexPath, after);
      removed.push("codex");
    }
  }

  let stopped = 0;
  for (const pid of liveServerPids()) {
    try {
      process.kill(pid);
      stopped++;
    } catch {
      // Already gone between listing and killing; nothing to do.
    }
  }

  output.write(
    [
      "[ok] browsight stopped.",
      `     unregistered from: ${removed.length > 0 ? removed.join(", ") : "no clients"}`,
      `     running servers stopped: ${stopped}`,
      "",
      "It stays off until you run `npx browsight start`.",
      "",
    ].join("\n"),
  );
}

/** Turn browsight back on by re-registering it with the selected MCP clients. */
export async function runStart(clients: ClientId[] | null): Promise<void> {
  const npx = isNpxContext();
  const entry = npx ? mcpNpxEntry() : mcpServerEntry(SERVER_ENTRY);
  const { registered } = registerClients(entry, clients);
  output.write(
    [
      registered.length > 0
        ? `[ok] browsight started, registered with: ${registered.join(", ")}`
        : "[!] no MCP client found, so browsight was not registered anywhere.",
      "",
      "Restart your MCP client so it picks this up.",
      "",
    ].join("\n"),
  );
}

export async function runSetup(
  options: { readonly newPort?: boolean; readonly clients?: ClientId[] | null } = {},
): Promise<void> {
  const npx = isNpxContext();

  // Reuse the existing token + port if setup has run before, so re-running never moves the port out
  // from under a server that is already using it (the cause of ERR_CONNECTION_REFUSED on re-setup).
  const existing = readJson(bridgeConfigPath());
  const token = typeof existing.token === "string" ? existing.token : generateToken();
  let port: number;
  if (options.newPort) {
    port = await pickPort(0);
  } else if (typeof existing.port === "number") {
    port = existing.port;
  } else {
    port = await pickPort(8137);
  }
  const host = typeof existing.host === "string" ? existing.host : "127.0.0.1";

  writeSecretJson(bridgeConfigPath(), { host, port, token });

  // Always copy the bundled extension to a permanent ~/.browsight/extension/ folder
  // so Chrome can load it from a single stable path.
  const extensionDistPath = extensionHome();
  installExtension();

  writeSecretJson(join(extensionDistPath, "connection.json"), { host, port, token });

  // Write the correct MCP entry for this context.
  const entry = npx ? mcpNpxEntry() : mcpServerEntry(SERVER_ENTRY);

  const only = options.clients ?? null;
  const { registered, skipped } = registerClients(entry, only);

  const lines = [
    // Registering nothing is not success: without a client entry no agent can reach browsight.
    registered.length > 0
      ? `[ok] browsight registered with: ${registered.join(", ")}`
      : "[!] no MCP client found, so browsight was not registered anywhere. Install one (Claude Code, Cursor, Windsurf, Antigravity, Codex) and run setup again.",
    ...(skipped.length > 0 ? [`    also installed, not registered: ${skipped.join(", ")}`] : []),
    "",
    // The path is always printed. It used to be shown only on a first install, decided by whether
    // the folder existed, which stays true after the extension is removed from Chrome: anyone in
    // that state was told to reload a card that was not there, and never given the path.
    "Next, in Chrome: menu > Extensions > Manage extensions > Load unpacked",
    "",
    `  ${extensionDistPath}`,
    "",
    "Then restart your MCP client so it picks up the new configuration.",
    "",
    // Without this, `start` and `stop` are only discoverable by running `browsight help`, so the
    // control the user most often wants (turning it off, and having it stay off) stays hidden.
    "Everyday commands:",
    "  npx browsight stop      turn browsight off, it stays off until you start it again",
    "  npx browsight start     turn it back on",
    "  npx browsight doctor    check the installation and the connection",
  ];
  output.write(`${lines.join("\n")}\n`);
}

/** One link in the chain, and the command that repairs it. */
interface DoctorCheck {
  readonly label: string;
  readonly ok: boolean;
  readonly fix?: string;
}

/** Repairs every link, so it is the right answer unless a check knows a narrower one. */
const DEFAULT_FIX = "npx browsight setup";

/**
 * Where doctor looks. Defaults to the real build output; injectable because the test suite runs
 * before `npm run build`, so a check reaching for real build output would fail on a fresh checkout.
 */
export interface DoctorPaths {
  readonly serverEntry?: string;
  readonly extensionDist?: string;
}

export function runDoctor(paths: DoctorPaths = {}): void {
  const serverEntry = paths.serverEntry ?? SERVER_ENTRY;
  const extensionDist = paths.extensionDist ?? EXTENSION_DIST_SRC;
  const codexPath = codexConfigPath();
  const codexRegistered =
    existsSync(codexPath) && /^\[mcp_servers\.browsight\]/m.test(readFileSync(codexPath, "utf8"));
  const registered =
    codexRegistered ||
    clientConfigPaths().some(
      (path: string) =>
        "browsight" in ((readJson(path).mcpServers as Record<string, unknown> | undefined) ?? {}),
    );
  const checks: readonly DoctorCheck[] = [
    { label: "server built (server/dist/index.mjs)", ok: existsSync(serverEntry) },
    {
      label: "extension built (extension/dist/manifest.json)",
      ok:
        existsSync(join(extensionDist, "manifest.json")) ||
        existsSync(join(extensionHome(), "manifest.json")),
    },
    {
      // The failure that looks like nothing is wrong: the folder is there and the extension
      // reloads, but it keeps running old code because the build never reached the install.
      label: "installed extension matches the build",
      ok: !installedExtensionIsStale(extensionDist),
      fix: "npx browsight setup",
    },
    {
      label: "bridge config written (~/.browsight/bridge.json)",
      ok: existsSync(bridgeConfigPath()),
    },
    {
      label: "extension connection.json written",
      ok:
        existsSync(join(extensionDist, "connection.json")) ||
        existsSync(join(extensionHome(), "connection.json")),
    },
    {
      label: "MCP server registered in a client config",
      ok: registered,
      // The usual reason this link is missing is that the user ran `stop`, which promises browsight
      // stays off until `start`. Sending them to `setup` would contradict what stop just told them.
      fix: "npx browsight start",
    },
  ];
  for (const check of checks) {
    output.write(`${check.ok ? "[ok]" : "[missing]"} ${check.label}\n`);
  }
  const firstBroken = checks.find((check) => !check.ok);
  output.write(
    firstBroken
      ? `\nNext: fix "${firstBroken.label}", run \`${firstBroken.fix ?? DEFAULT_FIX}\`.\n`
      : "\nAll links connected. If a read still fails, whitelist the site in the browsight popup.\n",
  );
}

export function runServe(args: readonly string[] = []): number {
  if (!existsSync(SERVER_ENTRY)) {
    output.error("browsight server is not built; reinstall the package or run `npm run build`\n");
    return 1;
  }
  const child = spawnSync(process.execPath, [SERVER_ENTRY, ...args], { stdio: "inherit" });
  if (child.error) {
    output.error(`browsight server failed: ${String(child.error)}\n`);
    return 1;
  }
  return child.status ?? 0;
}

export async function runCli(args: readonly string[]): Promise<number> {
  const [command, ...rest] = args;
  if (command === undefined || command === "setup") {
    await runSetup({ newPort: rest.includes("--new-port"), clients: parseClientFilter(rest) });
    return 0;
  }
  if (command === "stop") {
    runStop();
    return 0;
  }
  if (command === "start") {
    await runStart(parseClientFilter(rest));
    return 0;
  }
  if (command === "doctor") {
    runDoctor();
    return 0;
  }
  if (command === "serve") {
    return runServe(rest);
  }
  if (command === "help" || command === "--help" || command === "-h") {
    output.write(
      "browsight <command>\n\nCommands:\n  setup   Configure clients and install the extension (--new-port, --client=claude,cursor)\n  start   Register browsight with your MCP clients (--client=claude,cursor)\n  stop    Unregister browsight and stop any running server\n  doctor  Check the local installation\n  serve   Start the MCP server (supports --idle-timeout <minutes>)\n",
    );
    return 0;
  }
  output.error(`unknown browsight command: ${command}\n`);
  return 1;
}

let isMain = false;
if (process.argv[1]) {
  try {
    isMain = realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    // Ignore symlink resolution errors
  }
}
if (isMain) {
  try {
    const exitCode = await runCli(process.argv.slice(2));
    if (exitCode !== 0) {
      process.exit(exitCode);
    }
  } catch (err: unknown) {
    const command = process.argv[2] ?? "setup";
    let errMsg = "Unknown error";
    if (err instanceof Error) {
      errMsg = err.message;
    } else if (typeof err === "string") {
      errMsg = err;
    } else {
      // String() would flatten a thrown object to "[object Object]".
      errMsg = inspect(err, { depth: 2 });
    }
    output.error(`${command} failed: ${errMsg}\n`);
    process.exit(1);
  }
}
