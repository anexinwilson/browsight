/**
 * Defers binding the loopback port until a browser tool is actually called.
 *
 * MCP clients spawn every configured server the moment they launch, so browsight
 * gets started whether or not the user ever touches a browser tool. Binding the
 * port at startup meant an unused browsight in one client blocked a second client
 * from starting at all. Nothing is bound here until the first read/act/tabs call,
 * and the port is released again once the bridge goes idle.
 */
import type { Action, ActResponse, FieldFill, ReadResponse, TabsResponse } from "@browsight/shared";
import type { Bridge, BridgeOptions, BridgeStatus, ReadOptions, ReloadResult } from "./bridge.ts";

export interface LazyBridge extends Bridge {
  /** Closes the listener and frees the port. The next tool call re-binds. */
  release(reason: string): Promise<void>;
  /** True when a listener is currently bound. */
  isBound(): boolean;
}

export interface LazyBridgeOptions {
  readonly options: BridgeOptions;
  /** Injected so tests can supply a bridge without opening a socket. */
  readonly start: (options: BridgeOptions) => Promise<Bridge>;
  readonly onBind?: () => void;
  readonly onRelease?: (reason: string) => void;
}

export function createLazyBridge(opts: LazyBridgeOptions): LazyBridge {
  let current: Bridge | null = null;
  let pendingStart: Promise<Bridge> | null = null;
  /**
   * Bumped by every release. A bind that finishes after the release it raced is no longer wanted:
   * without this it would install itself as `current`, re-binding the port on a bridge nobody is
   * holding and, on shutdown, leaving a listener behind on a process that is exiting.
   */
  let generation = 0;

  async function ensure(): Promise<Bridge> {
    if (current) return current;
    const startedAt = generation;
    // Concurrent first calls must share one bind attempt, not race for the port.
    pendingStart ??= opts.start(opts.options).then(
      (bridge) => {
        pendingStart = null;
        if (generation !== startedAt) {
          void bridge.close().catch(() => {});
          throw new Error("browsight released the port while it was connecting; call again");
        }
        current = bridge;
        opts.onBind?.();
        return bridge;
      },
      (err) => {
        pendingStart = null;
        throw err;
      },
    );
    return await pendingStart;
  }

  return {
    ready: Promise.resolve(),

    isBound: () => current !== null,

    async release(reason: string): Promise<void> {
      generation += 1;
      const bridge = current;
      current = null;
      if (!bridge) return;
      try {
        await bridge.close();
      } catch {}
      opts.onRelease?.(reason);
    },

    // Reporting must never bind, asking whether browsight is connected should not
    // be the thing that makes it connect.
    status(): BridgeStatus {
      if (!current) {
        return {
          extensionConnected: false,
          detail:
            "browsight is idle and holding no port, call a browser tool (read, act, or tabs) and it will connect on demand.",
          port: 0,
          configPort: opts.options.port,
          extensionVersion: null,
          activeGrants: 0,
        };
      }
      return current.status();
    },

    async reloadConfig(): Promise<ReloadResult> {
      if (!current) {
        return {
          changed: false,
          detail: "browsight is idle; the next tool call picks up the current config.",
        };
      }
      return await current.reloadConfig();
    },

    async readActiveTab(url: string | null, options?: ReadOptions): Promise<ReadResponse> {
      const bridge = await ensure();
      return await bridge.readActiveTab(url, options);
    },

    async actActiveTab(req: {
      ref: string;
      action: Action;
      value?: string;
      fields?: FieldFill[];
    }): Promise<ActResponse> {
      const bridge = await ensure();
      return await bridge.actActiveTab(req);
    },

    async listTabs(select: string | null): Promise<TabsResponse> {
      const bridge = await ensure();
      return await bridge.listTabs(select);
    },

    async close(): Promise<void> {
      await this.release("closed");
    },
  };
}
