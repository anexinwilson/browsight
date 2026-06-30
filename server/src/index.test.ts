import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const INDEX_PATH = join(import.meta.dirname, "index.ts");

test("index.ts - graceful failure when config is missing", async () => {
  const emptyHome = join(
    tmpdir(),
    `browsight-empty-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );

  const child = spawn(process.execPath, [INDEX_PATH], {
    env: {
      ...process.env,
      USERPROFILE: emptyHome,
      HOME: emptyHome,
      BROWSIGHT_HOME: emptyHome,
    },
  });

  try {
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    const exitCode = await new Promise<number | null>((resolve) => {
      child.on("close", resolve);
    });

    assert.equal(exitCode, 1);
    assert.match(stderr, /browsight server failed to start:/);
  } finally {
    try {
      rmSync(emptyHome, { recursive: true, force: true });
    } catch {}
  }
});

test("index.ts - standard boot and response to JSON-RPC initialization when config is present", async () => {
  const testHome = join(
    tmpdir(),
    `browsight-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const configDir = join(testHome, ".browsight");
  mkdirSync(configDir, { recursive: true });

  // Write bridge config with port 0 so it binds to a random free port
  writeFileSync(join(configDir, "bridge.json"), JSON.stringify({ port: 0, token: "test-token" }));

  const child = spawn(process.execPath, [INDEX_PATH], {
    env: {
      ...process.env,
      USERPROFILE: testHome,
      HOME: testHome,
      BROWSIGHT_HOME: testHome,
    },
  });

  try {
    // Wait for the server to be ready for JSON-RPC initialization request
    const initRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: {
          name: "test-client",
          version: "1.0.0",
        },
      },
    };

    child.stdin.write(`${JSON.stringify(initRequest)}\n`);

    const response = await new Promise<any>((resolve, reject) => {
      let stdout = "";
      const timer = setTimeout(() => {
        reject(new Error(`Timeout waiting for initialize response. stdout: ${stdout}`));
      }, 8000);

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
        // Try to parse the response
        try {
          const parsed = JSON.parse(stdout.trim());
          clearTimeout(timer);
          resolve(parsed);
        } catch {
          // May be incomplete JSON, keep reading
        }
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        reject(new Error(`Child exited early with code ${code}. stdout: ${stdout}`));
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    assert.equal(response.jsonrpc, "2.0");
    assert.equal(response.id, 1);
    assert.ok(response.result);
    assert.equal(response.result.serverInfo.name, "browsight");
  } finally {
    child.kill();
    try {
      rmSync(testHome, { recursive: true, force: true });
    } catch {}
  }
});
