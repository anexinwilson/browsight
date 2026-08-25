/**
 * Records this server's PID so `browsight stop` can find and terminate it. Written on startup and
 * removed on shutdown, one file per process, because a machine can run several servers at once,
 * one per MCP client that has browsight registered.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serversDir } from "@browsight/shared/paths";

export function recordServer(pid: number = process.pid, dir: string = serversDir()): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${pid}`);
  writeFileSync(path, String(Date.now()), { mode: 0o600 });
  return path;
}

export function forgetServer(pid: number = process.pid, dir: string = serversDir()): void {
  rmSync(join(dir, `${pid}`), { force: true });
}

/** PIDs of servers that are still alive. Entries for dead processes are cleaned up as we go. */
export function liveServerPids(dir: string = serversDir()): number[] {
  if (!existsSync(dir)) {
    return [];
  }
  const alive: number[] = [];
  for (const name of readdirSync(dir)) {
    const pid = Number.parseInt(name, 10);
    if (Number.isNaN(pid)) {
      continue;
    }
    try {
      // Signal 0 tests for existence without touching the process.
      process.kill(pid, 0);
      alive.push(pid);
    } catch {
      rmSync(join(dir, name), { force: true });
    }
  }
  return alive;
}
