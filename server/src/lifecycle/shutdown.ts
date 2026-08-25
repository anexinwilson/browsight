/**
 * Shutting the server down once, no matter how many things ask for it.
 *
 * The same process can be told to stop from a dozen directions: the MCP connection closing, stdin
 * ending, a broken stdout pipe, the parent process disappearing, and four signals. They can arrive
 * together, so the sequence has to be idempotent, and it has to finish even if closing the bridge
 * hangs — an MCP client that spawned this process will otherwise wait on it forever.
 *
 * Keeping that here, rather than inline in the entry point, is what makes it testable: the entry
 * point runs on import and cannot be exercised without starting a real server.
 */

/** How long bridge teardown gets before the process exits regardless. */
const FORCE_EXIT_MS = 1000;

export interface ShutdownOptions {
  /** Release whatever the process holds. Failures here must not prevent exit. */
  close: () => Promise<void>;
  /** Runs before `close`, for bookkeeping that must happen even if teardown stalls. */
  before?: () => void;
  report?: (message: string) => void;
  exit?: (code: number) => void;
  forceExitMs?: number;
}

export type Shutdown = (reason: string) => Promise<void>;

export function createShutdown(options: ShutdownOptions): Shutdown {
  const {
    close,
    before,
    report = (message) => process.stderr.write(message),
    exit = (code) => process.exit(code),
    forceExitMs = FORCE_EXIT_MS,
  } = options;
  let started = false;

  return async (reason: string): Promise<void> => {
    if (started) {
      return;
    }
    started = true;
    before?.();

    // Unref'd so it never keeps the process alive on its own, but still forces an exit if teardown
    // stalls on a socket that will not close.
    const forceExit = setTimeout(() => exit(0), forceExitMs);
    forceExit.unref?.();

    report(`browsight: ${reason}; shutting down\n`);
    try {
      await close();
    } catch {
      // Exiting is the point; a failure to close cleanly must not block it.
    }
    clearTimeout(forceExit);
    exit(0);
  };
}

/** Every signal that should end the process, with the reason each one reports. */
const SIGNALS: ReadonlyArray<NodeJS.Signals> = ["SIGINT", "SIGTERM", "SIGHUP"];

/**
 * Wire the stdio streams and signals that mean "stop".
 *
 * `SIGBREAK` only exists on Windows, where it is what Ctrl+Break sends; registering it elsewhere
 * would throw.
 */
export function installShutdownTriggers(shutdown: Shutdown, proc: NodeJS.Process = process): void {
  const trigger = (reason: string) => () => {
    void shutdown(reason);
  };

  proc.stdin.once("end", trigger("MCP stdin ended"));
  proc.stdin.once("close", trigger("MCP stdin closed"));
  proc.stdin.on("error", trigger("MCP stdin error"));
  proc.stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") {
      void shutdown("MCP stdout pipe broken (EPIPE)");
    }
  });

  for (const signal of SIGNALS) {
    proc.on(signal, trigger(`${signal} received`));
  }
  if (proc.platform === "win32") {
    proc.on("SIGBREAK", trigger("SIGBREAK received"));
  }
}
