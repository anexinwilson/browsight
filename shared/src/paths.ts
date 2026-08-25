/**
 * The one description of where browsight keeps its files. The server reads these paths, `setup`
 * writes them, and the extension is loaded from one of them, so a second definition anywhere means
 * one side can silently look in a folder the other never wrote to.
 *
 * Exported from `@browsight/shared/paths` rather than the package root: the extension imports the
 * root for protocol types and must never pull `node:os` into a browser bundle.
 */
import { homedir } from "node:os";
import { join } from "node:path";

/** Overridable with $BROWSIGHT_HOME so the whole install can be redirected in tests. */
export function browsightHome(): string {
  return process.env.BROWSIGHT_HOME ?? homedir();
}

/** The directory holding everything browsight owns on this machine. */
export function browsightDir(): string {
  return join(browsightHome(), ".browsight");
}

/** Port and token shared between the server and the extension. */
export function bridgeConfigPath(): string {
  return join(browsightDir(), "bridge.json");
}

/** Where `setup` installs the extension, and the folder Chrome must be told to load. */
export function extensionHome(): string {
  return join(browsightDir(), "extension");
}

/** One file per running server, so `browsight stop` can find them all. */
export function serversDir(): string {
  return join(browsightDir(), "servers");
}
