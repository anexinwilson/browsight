# Handoff Report - Test Coverage Gaps Investigation

## 1. Observation

Direct observations were gathered by executing the test suite with coverage collection in Node.js v24.12.0 and parsing the generated `lcov.info` data.

### Commands and Outputs:
* Run test coverage:
  ```powershell
  node --test --experimental-test-coverage --test-reporter=lcov "**/*.test.ts" > scratch/coverage.lcov
  ```
* LCOV parsing results for target files:
  * **`server/src/index.ts`**: **0% Coverage**. Completely omitted from the coverage report (never imported or run by the test suite).
  * **`server/src/extract.ts`**: **100% Line Coverage** (69/69 covered lines).
  * **`server/src/bridge.ts`**: **84.7% Line Coverage** (144/170 covered lines).
    * Uncovered line numbers: `63`, `64`, `65`, `74`, `75`, `83`, `84`, `92`, `109`, `110`, `111`, `112`, `128`, `129`, `143`, `144`, `145`, `146`, `147`, `148`, `149`, `150`, `151`, `154`, `155`, `156`.
  * **`scripts/setup.ts`**: **93.1% Line Coverage** (217/233 covered lines).
    * Uncovered line numbers: `131`, `132`, `148`, `149`, `222`, `223`, `224`, `225`, `226`, `227`, `228`, `229`, `230`, `231`, `232`, `233`.

### Code Observations:
* **`server/src/index.ts` (Lines 36-41)**:
  ```typescript
  try {
    await main();
  } catch (err: unknown) {
    process.stderr.write(`browsight server failed to start: ${String(err)}\n`);
    process.exit(1);
  }
  ```
  Importing this file directly in-process will immediately execute `main()`, causing it to throw a `TypeError` and call `process.exit(1)` (terminating the test suite) if `bridge.json` is missing/invalid, or call `server.connect(new StdioServerTransport())` and hang on `process.stdin` if the config is valid.
* **`server/src/bridge.ts`**:
  * Lines `63-65` handle connection termination upon authentication timeout (`AUTH_TIMEOUT_MS`).
  * Lines `74-75` catch JSON parsing errors or schema validation failures from inbound WebSocket frames.
  * Lines `83-84` terminate connections that provide invalid auth tokens.
  * Line `92` handles `"tabs.response"` message types.
  * Lines `109-112` reject pending requests when a WebSocket connection closes mid-request.
  * Lines `128-129` reject requests exceeding `REQUEST_TIMEOUT_MS`.
  * Lines `143-151` and `154-156` implement `actActiveTab` and `listTabs` respectively, which are never called in `bridge.test.ts`.
* **`scripts/setup.ts`**:
  * Lines `131-132` handle double-failure fallback in `pickPort` (i.e., when both `tryPort(preferred)` and `tryPort(0)` reject).
  * Lines `148-149` catch parsing failures in `readJson` (returning empty `{}`).
  * Lines `222-233` contain the CLI execution block under `if (isMain)` which checks process arguments to run `runDoctor()` or `runSetup()` and catches initialization failures.

---

## 2. Logic Chain

1. **`server/src/index.ts` Isolation**:
   * *Observation*: Importing `index.ts` invokes `main()` which calls `process.exit(1)` or hangs on standard input.
   * *Reasoning*: To test `index.ts` safely without exiting the runner, we must either (a) mock the dependency endpoints (like `node:fs`'s `readFileSync`, `node:os`'s `homedir`, and `@modelcontextprotocol/sdk`) before the ESM evaluation takes place, or (b) execute the script in a detached child process.
   * *Experiment*: In ESM, static named imports (e.g. `import { readFileSync } from "node:fs"`) bind directly to module exports. Our test proved that patching `fs.readFileSync` after loading does not affect already-compiled ESM bindings. However, Node 24's `--experimental-test-module-mocks` flag enables `mock.module` to mock built-in modules, local relative modules, and packages before dynamic imports are evaluated.
   * *Conclusion*: We can write an in-process integration test by running Node with `--experimental-test-module-mocks`, calling `mock.module` for `node:fs`, `node:os`, `./bridge.ts`, and `./mcp.ts` to mock all external side-effects, and then dynamically importing `index.ts` via `await import('./index.ts')`. Alternatively, we can spawn a child process (process isolation) to verify startup failures and stdio messages safely.

2. **`server/src/bridge.ts` Gaps**:
   * *Observation*: The `bridge.test.ts` file only runs a single successful handshake test and two basic error tests.
   * *Reasoning*:
     * `actActiveTab` and `listTabs` are untested because they are never called in `bridge.test.ts`. Proposing tests that execute these functions and return mocked responses will resolve this.
     * Auth timeouts, token mismatches, and disconnect cleanup are untested. We can test these by waiting for timers (or utilizing Node's mock timer API `t.mock.timers.tick`) and asserting socket closures and promise rejections.

3. **`scripts/setup.ts` Gaps**:
   * *Observation*: The CLI runner (`isMain`), dual network failure in `pickPort`, and malformed JSON recovery in `readJson` are not covered.
   * *Reasoning*:
     * We can cover the `isMain` runner by spawning `node scripts/setup.ts` in a child process and inspecting its stdout.
     * We can cover the network failure by mocking `net.createServer` to reject all connections.
     * We can cover `readJson` recovery by writing invalid JSON strings to the bridge config directory before running `setup` tests.

---

## 3. Caveats

* **Experimental Feature Flag**: The in-process module-mocking method requires running the test suite with the `--experimental-test-module-mocks` flag in Node 24. If this flag is omitted, `mock.module` will be undefined.
* **Child Process OS Differences**: Child process spawning behaves differently across Windows and Unix. Command paths (such as `process.execPath`) must be used instead of hardcoding `node` or `./scripts/setup.ts`.

---

## 4. Conclusion & Test Strategies

### Strategy for `server/src/index.ts`

#### Option A: In-Process Module Mocking (Requires `--experimental-test-module-mocks`)
Create `server/src/index.test.ts` and set up the mocks before importing `index.ts`:

```typescript
import assert from "node:assert/strict";
import { mock, test } from "node:test";

test("index.ts boots and connects transport correctly", async (t) => {
  // 1. Mock built-in modules
  mock.module("node:fs", {
    namedExports: {
      readFileSync: (path: string) => {
        if (path.endsWith("bridge.json")) {
          return JSON.stringify({ port: 8137, token: "mocked-token-123" });
        }
        throw new Error("File not found");
      }
    }
  });

  mock.module("node:os", {
    namedExports: {
      homedir: () => "/mock/home"
    }
  });

  // 2. Mock local relative dependencies
  let bridgeStartedWith: any = null;
  mock.module("./bridge.ts", {
    namedExports: {
      startBridge: (config: any) => {
        bridgeStartedWith = config;
        return {
          readActiveTab: async () => {},
          actActiveTab: async () => {},
          listTabs: async () => {},
          close: async () => {},
        };
      }
    }
  });

  let mcpServerCreatedWith: any = null;
  let connectCalled = false;
  mock.module("./mcp.ts", {
    namedExports: {
      createMcpServer: (bridge: any) => {
        mcpServerCreatedWith = bridge;
        return {
          connect: async (transport: any) => {
            connectCalled = true;
          }
        };
      }
    }
  });

  // 3. Mock MCP SDK Stdio transport
  mock.module("@modelcontextprotocol/sdk/server/stdio.js", {
    namedExports: {
      StdioServerTransport: class MockStdioServerTransport {}
    }
  });

  // 4. Dynamically import the entry point
  await import("./index.ts");

  // 5. Assert all components were correctly wired together
  assert.deepEqual(bridgeStartedWith, { port: 8137, token: "mocked-token-123" });
  assert.ok(mcpServerCreatedWith);
  assert.ok(connectCalled);
});
```

#### Option B: Detached Process Isolation (Alternative / Non-Experimental)
Run tests by spawning `index.ts` (or the compiled output) in a child process and controlling the environment variables:

```typescript
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

test("index.ts fails gracefully on missing config", async () => {
  const emptyHome = mkdtempSync(join(tmpdir(), "browsight-test-empty-"));
  const child = spawn(process.execPath, [join(process.cwd(), "server", "src", "index.ts")], {
    env: { ...process.env, BROWSIGHT_HOME: emptyHome, USERPROFILE: emptyHome, HOME: emptyHome },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  const exitCode = await new Promise((resolve) => child.on("exit", resolve));
  assert.equal(exitCode, 1);
  assert.match(stderr, /invalid bridge config/);
});

test("index.ts loads config and responds to JSON-RPC initialization", async () => {
  const testHome = mkdtempSync(join(tmpdir(), "browsight-test-home-"));
  writeFileSync(
    join(testHome, "bridge.json"),
    JSON.stringify({ port: 8138, token: "rpc-test-token" })
  );

  const child = spawn(process.execPath, [join(process.cwd(), "server", "src", "index.ts")], {
    env: { ...process.env, BROWSIGHT_HOME: testHome, USERPROFILE: testHome, HOME: testHome },
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Send an invalid/dummy JSON-RPC frame to standard input to verify transport is active
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");

  const response = await new Promise<string>((resolve) => {
    child.stdout.on("data", (chunk) => {
      resolve(chunk.toString());
    });
  });

  assert.match(response, /jsonrpc/);
  
  // Teardown
  child.kill();
});
```

---

### Strategy for `server/src/bridge.ts`

Add these test cases to `server/src/bridge.test.ts`:

1. **`actActiveTab` and `listTabs` Coverage**:
   Verify the full request/response loop, ensuring message routing and Zod parser safety:
   ```typescript
   test("bridge handles actActiveTab and listTabs routing", async () => {
     const port = 8252;
     const token = "act-tabs-token";
     const bridge = startBridge({ port, token });
     const ws = new WebSocket(`ws://127.0.0.1:${port}`);
     try {
       await new Promise<void>((resolve, reject) => {
         ws.once("open", resolve);
         ws.once("error", reject);
       });
       ws.send(JSON.stringify({ type: "auth", token, extensionVersion: "test" }));

       ws.on("message", (data) => {
         const msg = JSON.parse(data.toString());
         if (msg.type === "act.request") {
           ws.send(JSON.stringify({ type: "act.response", id: msg.id, verdict: "success", error: null }));
         } else if (msg.type === "tabs.request") {
           ws.send(JSON.stringify({ type: "tabs.response", id: msg.id, tabs: [], switched: true, error: null }));
         }
       });
       await new Promise((resolve) => setTimeout(resolve, 50));

       const actRes = await bridge.actActiveTab({ ref: "btn-1", action: "click" });
       assert.equal(actRes.verdict, "success");

       const tabsRes = await bridge.listTabs("test");
       assert.equal(tabsRes.switched, true);
     } finally {
       ws.close();
       await bridge.close();
     }
   });
   ```

2. **Auth Timeout and Token Mismatch Coverage**:
   Verify authorization lifecycle and security closure codes:
   ```typescript
   test("bridge handles auth timeout and token rejection", async (t) => {
     t.mock.timers.enable({ apis: ["setTimeout"] });
     const port = 8253;
     const bridge = startBridge({ port, token: "valid-token" });

     // Test 1: Wrong token rejection
     const wsWrong = new WebSocket(`ws://127.0.0.1:${port}`);
     await new Promise<void>((res) => wsWrong.once("open", res));
     wsWrong.send(JSON.stringify({ type: "auth", token: "wrong-token", extensionVersion: "test" }));
     const codeWrong = await new Promise((resolve) => wsWrong.once("close", (code) => resolve(code)));
     assert.equal(codeWrong, 1008);

     // Test 2: Auth timeout
     const wsTimeout = new WebSocket(`ws://127.0.0.1:${port}`);
     await new Promise<void>((res) => wsTimeout.once("open", res));
     const closedPromise = new Promise((resolve) => wsTimeout.once("close", (code) => resolve(code)));
     t.mock.timers.tick(2500); // Advance past AUTH_TIMEOUT_MS (2,000ms)
     const codeTimeout = await closedPromise;
     assert.equal(codeTimeout, 1008);

     await bridge.close();
   });
   ```

3. **Mid-Request Disconnect and Request Timeout Coverage**:
   Verify resource cleanup and error boundaries:
   ```typescript
   test("bridge cleans up requests on disconnect and handles timeouts", async (t) => {
     t.mock.timers.enable({ apis: ["setTimeout"] });
     const port = 8254;
     const bridge = startBridge({ port, token: "valid-token" });
     const ws = new WebSocket(`ws://127.0.0.1:${port}`);
     try {
       await new Promise<void>((res) => ws.once("open", res));
       ws.send(JSON.stringify({ type: "auth", token: "valid-token", extensionVersion: "test" }));
       await new Promise((res) => setTimeout(res, 50));

       // Test disconnect
       const pending1 = bridge.readActiveTab(null);
       ws.close();
       await assert.rejects(pending1, /the browsight extension disconnected/);

       // Reconnect and test request timeout
       const ws2 = new WebSocket(`ws://127.0.0.1:${port}`);
       await new Promise<void>((res) => ws2.once("open", res));
       ws2.send(JSON.stringify({ type: "auth", token: "valid-token", extensionVersion: "test" }));
       await new Promise((res) => setTimeout(res, 50));

       const pending2 = bridge.readActiveTab(null);
       t.mock.timers.tick(31000); // Advance past REQUEST_TIMEOUT_MS (30,000ms)
       await assert.rejects(pending2, /timed out waiting for the extension/);
       ws2.close();
     } finally {
       await bridge.close();
     }
   });
   ```

---

### Strategy for `scripts/setup.ts`

Add these test cases to `scripts/setup.test.ts`:

1. **`pickPort` Secondary Failure Coverage**:
   Mock `net.createServer` to cause both ports to fail, forcing the fallback code path:
   ```typescript
   test("pickPort returns preferred when both attempts reject", async () => {
     const net = await import("node:net");
     mock.method(net, "createServer", () => {
       return {
         once: (event: string, cb: Function) => {
           if (event === "error") {
             process.nextTick(() => cb(new Error("mock network error")));
           }
         },
         listen: () => {},
         close: (cb: Function) => cb(),
       };
     });

     const port = await pickPort(8137);
     assert.equal(port, 8137); // returns preferred fallback
     mock.restoreAll();
   });
   ```

2. **`readJson` Parse Error Coverage**:
   Verify grace recovery when configuration JSON is corrupted:
   ```typescript
   test("runSetup recovers from malformed json config files", async () => {
     const tempHome = createTempHome();
     const originalHome = process.env.BROWSIGHT_HOME;
     process.env.BROWSIGHT_HOME = tempHome;

     mkdirSync(join(tempHome, ".browsight"), { recursive: true });
     writeFileSync(join(tempHome, ".browsight", "bridge.json"), "{ corrupted: json }");

     const originalWrite = process.stdout.write;
     process.stdout.write = () => true;

     try {
       await runSetup();
       // Assert that setup completed and overwrote the corrupted file with a valid one
       const bridgeJson = JSON.parse(readFileSync(join(tempHome, ".browsight", "bridge.json"), "utf8"));
       assert.ok(bridgeJson.token);
       assert.ok(bridgeJson.port);
     } finally {
       process.stdout.write = originalWrite;
       process.env.BROWSIGHT_HOME = originalHome;
       rmSync(tempHome, { recursive: true, force: true });
     }
   });
   ```

3. **`tomlString` Escaped Quotes Coverage**:
   Verify TOML generator handles paths containing quotes safely:
   ```typescript
   test("browsightCodexBlock handles paths with single quotes", () => {
     const block = browsightCodexBlock({
       command: "C:\\path'with'quote\\node.exe",
       args: ["simple-arg", 'arg"with"quote'],
     });
     assert.match(block, /command = "C:\\\\path'with'quote\\\\node.exe"/);
     assert.match(block, /args = \['simple-arg', 'arg"with"quote'\]/);
   });
   ```

4. **CLI Entry Point Integration Coverage**:
   Spawn `setup.ts` as a child process to exercise the `isMain` execution branches:
   ```typescript
   import { spawn } from "node:child_process";

   test("setup.ts runs runDoctor from CLI", async () => {
     const child = spawn(process.execPath, [join(process.cwd(), "scripts", "setup.ts"), "doctor"], {
       env: { ...process.env, BROWSIGHT_HOME: "/mock/empty" },
       stdio: ["pipe", "pipe", "pipe"],
     });

     let stdout = "";
     child.stdout.on("data", (chunk) => { stdout += chunk; });

     await new Promise((resolve) => child.on("exit", resolve));
     assert.match(stdout, /bridge config written/);
   });
   ```

---

## 5. Verification Method

To verify that these strategies successfully address the test coverage gaps:

1. **Review proposed code and execution**:
   Inspect the strategies and ensure they cover the identified lines:
   * `bridge.ts`: lines `63-65`, `74-75`, `83-84`, `92`, `109-112`, `128-129`, `143-151`, `154-156`.
   * `setup.ts`: lines `131-132`, `148-149`, `222-233`.
   * `index.ts`: 100% of statements.

2. **Execute coverage command**:
   After implementing the test cases, generate a new LCOV coverage report:
   ```powershell
   node --test --experimental-test-coverage --test-reporter=lcov "**/*.test.ts" > scratch/coverage.lcov
   ```
   Check that:
   * `server/src/index.ts` is now listed and shows high coverage.
   * `server/src/bridge.ts` and `scripts/setup.ts` line coverage reaches ~100%.
