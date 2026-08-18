/**
 * Parent process watchdog for orphan detection and termination.
 *
 * Polls the parent process PID using OS-level signal probing (`process.kill(pid, 0)`)
 * and reparenting detection to ensure the server automatically terminates if its
 * launching MCP client or parent shell exits unexpectedly.
 */

export interface WatchdogOptions {
  readonly parentPid?: number;
  readonly intervalMs?: number;
  readonly pollIntervalMs?: number;
  readonly onParentExit: (reason?: string) => void;
}

export interface ParentWatchdog {
  stop(): void;
}

/**
 * Probes whether a process with the given PID is currently alive in the OS process table.
 *
 * Uses `process.kill(pid, 0)`:
 * - Returns `true` if the signal check succeeds.
 * - Returns `true` if `EPERM` is thrown (process exists but belongs to another user / permission boundary).
 * - Returns `false` if `ESRCH` is thrown (no such process) or for invalid PIDs (<= 0 or non-integer).
 */
export function isProcessAlive(pid: number): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return code === "EPERM";
  }
}

/**
 * Starts a background watchdog interval monitoring the parent process.
 *
 * Polling timer is unreferenced (`unref()`) to prevent keeping the Node.js event loop
 * alive on its own.
 */
export function startParentWatchdog(options: WatchdogOptions): ParentWatchdog {
  const targetPid = options.parentPid ?? process.ppid;
  const intervalMs = options.intervalMs ?? options.pollIntervalMs ?? 200;
  const onParentExit = options.onParentExit;

  // If parent PID is invalid (<= 1, init, or self), watchdog cannot monitor
  if (
    typeof targetPid !== "number" ||
    !Number.isInteger(targetPid) ||
    targetPid <= 1 ||
    targetPid === process.pid
  ) {
    return { stop: () => {} };
  }

  const initialPpid = process.ppid;
  let active = true;

  const timer = setInterval(() => {
    if (!active) {
      return;
    }

    // POSIX reparenting check: if parent terminates, orphan is adopted by PID 1 (init/systemd)
    if (
      options.parentPid === undefined &&
      process.ppid !== initialPpid &&
      (process.ppid === 1 || process.ppid === 0)
    ) {
      active = false;
      clearInterval(timer);
      onParentExit("Parent process reparented to init");
      return;
    }

    if (!isProcessAlive(targetPid)) {
      active = false;
      clearInterval(timer);
      onParentExit(`Parent process (PID ${targetPid}) terminated`);
    }
  }, intervalMs);

  timer.unref();

  return {
    stop: () => {
      if (active) {
        active = false;
        clearInterval(timer);
      }
    },
  };
}
