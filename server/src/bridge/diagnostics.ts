/**
 * The messages browsight gives back when it cannot reach Chrome. These are deliberately long: an
 * MCP client discovers tools once at connect time, so a separate diagnostic tool is invisible right
 * after something changed, which is exactly when diagnosis matters. Everything the caller needs to
 * act on is in the one string.
 *
 * Kept pure and separate from the bridge so the wording can be read and tested without standing up
 * an HTTP server.
 */
import { extensionLoadPath, readBridgeConfig } from "./config.ts";

export interface DisconnectedState {
  /** Path to bridge.json, or null when the bridge was not started from a config file. */
  readonly configPath: string | null;
  readonly currentPort: number;
  readonly currentToken: string;
  /** True once an extension has attached at least once during this process's life. */
  readonly everSawExtension: boolean;
}

export function disconnectedReason(state: DisconnectedState): string {
  const onDisk = state.configPath ? readBridgeConfig(state.configPath) : null;
  if (onDisk && (onDisk.port !== state.currentPort || onDisk.token !== state.currentToken)) {
    return `browsight was reconfigured after this server started (this server is on port ${state.currentPort}, the config now says port ${onDisk.port}). Fix: call browser_status with reload=true, or restart your MCP client.`;
  }
  const seen = state.everSawExtension
    ? "The extension connected earlier and has since dropped"
    : "The extension has not connected since this server started";
  return `${seen}. browsight is listening on 127.0.0.1:${state.currentPort}, so the server side is healthy. Fix: open chrome://extensions and reload the browsight extension (it must be loaded from ${extensionLoadPath()}). It also retries on its own about once a minute.`;
}
