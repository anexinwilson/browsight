/**
 * Reading the bridge's shared state from disk. Where those files live is defined once in
 * `@browsight/shared/paths`, so the server and `setup` can never disagree about the layout.
 */
import { readFileSync } from "node:fs";
import { type Connection, parseConnection } from "@browsight/shared";
import { bridgeConfigPath } from "@browsight/shared/paths";

export { bridgeConfigPath, extensionHome as extensionLoadPath } from "@browsight/shared/paths";

/** The port and token currently on disk, or null if the file is missing or malformed. */
export function readBridgeConfig(path: string): Connection | null {
  try {
    return parseConnection(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

/**
 * The config the server boots from, or a failure a user can act on.
 *
 * Unlike `readBridgeConfig`, a missing or malformed file is fatal here: the server cannot serve
 * anything without a port and token, and silently starting on defaults would leave the extension
 * dialling a port nobody is listening on.
 */
export function loadBridgeConnection(path = bridgeConfigPath()): Connection {
  const parsed = readBridgeConfig(path);
  if (!parsed) {
    throw new TypeError(`invalid bridge config at ${path}, run \`npx browsight setup\``);
  }
  return parsed;
}
