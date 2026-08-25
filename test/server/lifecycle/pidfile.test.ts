import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  forgetServer,
  liveServerPids,
  recordServer,
} from "../../../server/src/lifecycle/pidfile.ts";

test("a server records its pid so stop can find it, and clears it on shutdown", () => {
  const dir = mkdtempSync(join(tmpdir(), "browsight-pids-"));
  const path = recordServer(process.pid, dir);
  assert.ok(existsSync(path), "the pid file is written");
  assert.deepStrictEqual(liveServerPids(dir), [process.pid]);

  forgetServer(process.pid, dir);
  assert.strictEqual(existsSync(path), false, "shutdown clears the pid file");
  assert.deepStrictEqual(liveServerPids(dir), []);
});

test("pid files left behind by dead servers are ignored and cleaned up", () => {
  const dir = mkdtempSync(join(tmpdir(), "browsight-pids-"));
  // A pid that cannot be running: process ids are positive and this one is far past any real max.
  writeFileSync(join(dir, "2147483646"), "0");
  writeFileSync(join(dir, "not-a-pid"), "0");
  recordServer(process.pid, dir);

  assert.deepStrictEqual(liveServerPids(dir), [process.pid], "only live servers are returned");
  assert.deepStrictEqual(readdirSync(dir), [String(process.pid), "not-a-pid"], "stale pid removed");
  forgetServer(process.pid, dir);
});

test("no servers directory means no servers, not a crash", () => {
  assert.deepStrictEqual(liveServerPids(join(tmpdir(), "browsight-missing-dir-xyz")), []);
});
