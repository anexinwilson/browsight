import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { isProcessAlive } from "../../../server/src/lifecycle/parent-watchdog.ts";

const INDEX_PATH = join(import.meta.dirname, "../../../server/src/index.ts");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function createTestSandbox() {
  const dir = join(
    tmpdir(),
    `browsight-orphan-unit-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const configDir = join(dir, ".browsight");
  mkdirSync(configDir, { recursive: true });
  return {
    dir,
    writeConfig(port = 0, token = "orphan-unit-token") {
      writeFileSync(join(configDir, "bridge.json"), JSON.stringify({ port, token }));
    },
    cleanup() {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    },
  };
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

test("server orphan termination - child auto-terminates <= 3000ms after parent kill", async () => {
  const sandbox = createTestSandbox();
  sandbox.writeConfig(0);

  let parentPid: number | null = null;
  let childPid: number | null = null;

  try {
    const parentCode = `
      import { spawn } from "node:child_process";
      const child = spawn(process.execPath, [${JSON.stringify(INDEX_PATH)}], {
        env: {
          ...process.env,
          BROWSIGHT_HOME: ${JSON.stringify(sandbox.dir)},
          HOME: ${JSON.stringify(sandbox.dir)},
          USERPROFILE: ${JSON.stringify(sandbox.dir)},
        },
        stdio: ["pipe", "pipe", "inherit"],
      });
      console.log(JSON.stringify({ type: "ready", parentPid: process.pid, childPid: child.pid }));
      setInterval(() => {}, 60000);
    `;

    const parentProc = spawn(process.execPath, ["--input-type=module", "-e", parentCode]);

    const data = await new Promise<{ parentPid: number; childPid: number }>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Timeout waiting for parent output")),
        8000,
      );
      let buffer = "";
      parentProc.stdout.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line.trim());
            if (parsed.type === "ready") {
              clearTimeout(timeout);
              resolve(parsed);
              return;
            }
          } catch {}
        }
      });
    });

    parentPid = data.parentPid;
    childPid = data.childPid;

    assert.ok(parentPid > 1, `Invalid parent PID: ${parentPid}`);
    assert.ok(childPid > 1, `Invalid child server PID: ${childPid}`);

    await sleep(400);
    assert.equal(isProcessAlive(childPid), true);

    const t0 = performance.now();
    try {
      process.kill(parentPid, "SIGKILL");
    } catch {}

    let terminated = false;
    let elapsed = 0;
    while (elapsed < 4000) {
      if (!isProcessAlive(childPid)) {
        terminated = true;
        break;
      }
      await sleep(15);
      elapsed = performance.now() - t0;
    }

    assert.ok(terminated, `Server child ${childPid} should terminate after parent killed`);
    assert.ok(elapsed <= 3000, `Termination took ${elapsed.toFixed(2)}ms (SLA is <= 3000ms)`);
  } finally {
    if (parentPid) {
      try {
        process.kill(parentPid, "SIGKILL");
      } catch {}
    }
    if (childPid) {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {}
    }
    sandbox.cleanup();
  }
});

test("server orphan termination - port is freed and reusable without EADDRINUSE", async () => {
  const port = await getFreePort();
  const sandbox = createTestSandbox();
  sandbox.writeConfig(port);

  let parentPid: number | null = null;
  let childPid: number | null = null;

  try {
    const parentCode = `
      import { spawn } from "node:child_process";
      const child = spawn(process.execPath, [${JSON.stringify(INDEX_PATH)}], {
        env: {
          ...process.env,
          BROWSIGHT_HOME: ${JSON.stringify(sandbox.dir)},
          HOME: ${JSON.stringify(sandbox.dir)},
          USERPROFILE: ${JSON.stringify(sandbox.dir)},
        },
        stdio: ["pipe", "pipe", "inherit"],
      });
      console.log(JSON.stringify({ type: "ready", parentPid: process.pid, childPid: child.pid }));
      setInterval(() => {}, 60000);
    `;

    const parentProc = spawn(process.execPath, ["--input-type=module", "-e", parentCode]);

    const data = await new Promise<{ parentPid: number; childPid: number }>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Timeout waiting for parent output")),
        8000,
      );
      let buffer = "";
      parentProc.stdout.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line.trim());
            if (parsed.type === "ready") {
              clearTimeout(timeout);
              resolve(parsed);
              return;
            }
          } catch {}
        }
      });
    });

    parentPid = data.parentPid;
    childPid = data.childPid;

    await sleep(400);
    assert.equal(isProcessAlive(childPid), true);

    try {
      process.kill(parentPid, "SIGKILL");
    } catch {}

    const t0 = performance.now();
    while (isProcessAlive(childPid)) {
      if (performance.now() - t0 > 3000) break;
      await sleep(15);
    }
    assert.equal(isProcessAlive(childPid), false);

    // Re-bind port immediately to assert no EADDRINUSE
    const rebound = await new Promise<boolean>((resolve) => {
      const srv = http.createServer();
      srv.once("error", () => resolve(false));
      srv.listen(port, "127.0.0.1", () => {
        srv.close(() => resolve(true));
      });
    });

    assert.equal(rebound, true, `Port ${port} should be rebound without EADDRINUSE`);
  } finally {
    if (parentPid) {
      try {
        process.kill(parentPid, "SIGKILL");
      } catch {}
    }
    if (childPid) {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {}
    }
    sandbox.cleanup();
  }
});

test("server orphan termination - parent stdin stream closure triggers clean exit", async () => {
  const sandbox = createTestSandbox();
  sandbox.writeConfig(0);

  let child: ReturnType<typeof spawn> | null = null;
  try {
    child = spawn(process.execPath, [INDEX_PATH], {
      env: {
        ...process.env,
        BROWSIGHT_HOME: sandbox.dir,
        HOME: sandbox.dir,
        USERPROFILE: sandbox.dir,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const childPid = child.pid;
    assert.ok(childPid && childPid > 1);
    await sleep(400);
    assert.equal(isProcessAlive(childPid), true);

    const t0 = performance.now();
    child.stdin?.end();

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Timeout waiting for child exit after stdin end")),
        3000,
      );
      child?.on("close", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });

    const elapsed = performance.now() - t0;
    assert.equal(exitCode, 0, "Server should exit 0 on stdin EOF");
    assert.ok(elapsed <= 2500, `Exit took ${elapsed.toFixed(2)}ms`);
  } finally {
    if (child?.pid) {
      try {
        child.kill("SIGKILL");
      } catch {}
    }
    sandbox.cleanup();
  }
});
