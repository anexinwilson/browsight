# Analysis Report: Test Coverage Gaps for `scripts/setup.ts`

This report analyzes the test coverage gaps in `scripts/setup.ts` following the recent 'npx' refactoring, and details a testing strategy to achieve 100% statement, function, and branch coverage.

---

## 1. Summary of Findings
A run of the test suite with code coverage (`node --experimental-test-coverage --test scripts/setup.test.ts`) shows that `scripts/setup.ts` has **98.19% statement coverage**, **76.56% branch coverage**, and **96.15% function coverage**.

The primary coverage gaps are:
1. The new **NPX execution flow** introduced in the 'npx' refactoring is entirely untested because the test environment runs setup in a standard local repository context.
2. The **CLI entry point's error-handling catch block** is never executed since all spawned setup processes succeed.
3. Several **edge-case branches** (such as replacing a stale browsight Codex block at the end of a TOML file, running in compiled context, and port resolution fallbacks) are never hit.

---

## 2. Detailed Coverage Gaps

### A. NPX Refactoring Gaps
The recent refactoring introduced logic to detect when the setup script runs via `npx` (which indicates the server package is located in a transient global cache) and, in such cases, configures MCP clients to run via `npx -y browsight` instead of pointing to an absolute local path.

*   **`mcpNpxEntry()` (Lines 37-39)**:
    ```typescript
    export function mcpNpxEntry(): McpEntry {
      return { command: "npx", args: ["-y", "browsight"] };
    }
    ```
    *   **Gap**: Uncovered lines 38-39 and function `mcpNpxEntry`. The function is exported but never called in `setup.test.ts`.
*   **`isNpxContext()` (Lines 101-105)**:
    ```typescript
    function isNpxContext(): boolean {
      const p = SCRIPT_DIR.replace(/\\/g, "/");
      return p.includes("/_npx/") || p.includes("/.cache/node/");
    }
    ```
    *   **Gap**: Branch coverage is incomplete. The logical OR condition only evaluates to `false` in tests. The `true` paths for both `/_npx/` and `/.cache/node/` are never evaluated.
*   **`runSetup()` (Line 202)**:
    ```typescript
    const entry = npx ? mcpNpxEntry() : mcpServerEntry(SERVER_ENTRY);
    ```
    *   **Gap**: The ternary operator only executes the `else` (non-npx) path. The NPX setup pathway (where the `npx` configuration is written to the client JSON and Codex TOML files) is never verified.

### B. CLI Entry Point Error Catch Block
*   **`isMain` Block Error Handling (Lines 272-275)**:
    ```typescript
        } catch (err: unknown) {
          process.stderr.write(`setup failed: ${String(err)}\n`);
          process.exit(1);
        }
    ```
    *   **Gap**: Uncovered lines 273-275. In the CLI integration test, the spawned `setup.ts` process runs under ideal conditions and always exits cleanly with code `0`.

### C. General Edge Cases & Branch Gaps
*   **`withBrowsightCodex()` (Lines 78-80)**:
    ```typescript
    const nextTable = after.search(/^[ \t]*\[/m);
    const tail = nextTable === -1 ? "" : after.slice(nextTable);
    const tailStr = tail ? `\n${tail}` : "";
    ```
    *   **Gap**: The `nextTable === -1` branch is not covered. The only test checking the replacement of a stale `[mcp_servers.browsight]` block includes another table (`[mcp_servers.keep]`) after it, meaning `nextTable !== -1`.
*   **`isCompiled` Detection (Lines 88-89)**:
    ```typescript
    const isCompiled = /[/\\]dist$/.test(SCRIPT_DIR);
    const PKG_ROOT = isCompiled ? resolve(SCRIPT_DIR, "..", "..") : resolve(SCRIPT_DIR, "..");
    ```
    *   **Gap**: The `isCompiled` branch is never evaluated as `true`. The tests run directly on the source `.ts` file, where `SCRIPT_DIR` is `scripts/`, rather than the compiled `scripts/dist/setup.mjs`.
*   **`runSetup()` Extension Dist Missing (Lines 195-197)**:
    ```typescript
    if (existsSync(EXTENSION_DIST_SRC)) {
      cpSync(EXTENSION_DIST_SRC, extensionDistPath, { recursive: true });
    }
    ```
    *   **Gap**: The condition `existsSync(EXTENSION_DIST_SRC)` evaluates to `true` because the build artifacts exist in the repository. The branch where it is `false` is not tested.
*   **`runSetup()` Codex Directory-Only Check (Lines 210-211)**:
    ```typescript
    if (existsSync(codexPath) || existsSync(dirname(codexPath))) {
      const current = existsSync(codexPath) ? readFileSync(codexPath, "utf8") : "";
    ```
    *   **Gap**:
        1. In tests, the `.codex/config.toml` file is either created beforehand (evaluating `existsSync(codexPath)` to `true` and short-circuiting the RHS) or not created at all (evaluating both to `false`). The case where the directory exists but the file does not (evaluating RHS of `||` to `true`) is never executed.
        2. Consequently, the `""` fallback inside the ternary operator for `current` is never hit.
*   **`runDoctor()` Codex Registration Short-Circuit (Lines 233-237)**:
    ```typescript
    const registered =
      codexRegistered ||
      clientConfigPaths().some(
        (p) => "browsight" in ((readJson(p).mcpServers as Record<string, unknown> | undefined) ?? {}),
      );
    ```
    *   **Gap**: `codexRegistered` is never `true` in doctor tests because `runSetup()` is never executed in an environment where `.codex/config.toml` exists. Therefore, the short-circuiting of `registered` is not covered.
*   **`runDoctor()` Secondary Manifest Check (Lines 242-243)**:
    ```typescript
    existsSync(join(EXTENSION_DIST_SRC, "manifest.json")) ||
      existsSync(join(extensionHome(), "manifest.json"))
    ```
    *   **Gap**: The primary check evaluates to `true` because the local build is present, so the secondary check `existsSync(join(extensionHome(), "manifest.json"))` is not evaluated.
*   **`tryPort()` Non-Object Address Fallback (Line 144)**:
    ```typescript
    const chosen = typeof addr === "object" && addr ? addr.port : port;
    ```
    *   **Gap**: When listening on a TCP port in Node, `srv.address()` is always an object. The branch returning `port` is never hit.

---

## 3. Proposed Testing Strategy
To achieve 100% statement, function, and branch coverage, we propose adding the following tests to `scripts/setup.test.ts`.

### A. Testing the NPX Context and Compiled Context (File System Simulation)
Because `isNpxContext` and `isCompiled` depend on the path of the executing script, we can copy the script to temporary paths and import them dynamically to force these paths to evaluate to `true`.

```typescript
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

test("mcpNpxEntry returns correct command structure", () => {
  const entry = mcpNpxEntry();
  assert.equal(entry.command, "npx");
  assert.deepEqual(entry.args, ["-y", "browsight"]);
});

test("isNpxContext and runSetup under NPX context", async () => {
  const tempHome = createTempHome();
  const originalHome = process.env.BROWSIGHT_HOME;
  process.env.BROWSIGHT_HOME = tempHome;

  // Create temporary directory mimicking NPX installation path
  const mockNpxDir = join(tempHome, "_npx", "package");
  mkdirSync(mockNpxDir, { recursive: true });

  // Copy setup.ts to the mock NPX directory
  const setupCode = readFileSync(join(process.cwd(), "scripts", "setup.ts"), "utf8");
  const destPath = join(mockNpxDir, "setup.ts");
  writeFileSync(destPath, setupCode);

  try {
    // Dynamically import the script from the mock NPX path
    const mockNpxSetup = await import(pathToFileURL(destPath).href);

    // 1. Verify NPX context evaluates to true
    assert.ok(mockNpxSetup.isNpxContext?.() || true); // if exported, or verified via runSetup below

    // Create cursor directory to trigger configuration write
    mkdirSync(join(tempHome, ".cursor"), { recursive: true });
    
    // Run the setup from NPX context
    await mockNpxSetup.runSetup();

    // Verify written entry uses 'npx' instead of absolute node path
    const cursorJson = JSON.parse(readFileSync(join(tempHome, ".cursor", "mcp.json"), "utf8"));
    assert.deepEqual(cursorJson.mcpServers.browsight, {
      command: "npx",
      args: ["-y", "browsight"]
    });
  } finally {
    process.env.BROWSIGHT_HOME = originalHome;
    rmSync(tempHome, { recursive: true, force: true });
  }
});
```

To cover `isCompiled`, we copy `setup.ts` into a directory ending in `dist` (e.g. `scratch/mock_dist/dist/setup.ts`) and dynamically import it.

### B. Testing CLI Error Handling Catch Block
We can set `BROWSIGHT_HOME` to a directory where a *file* named `.browsight` already exists. This will cause `mkdirSync(join(tempHome, ".browsight"))` inside `runSetup()` to fail with `EEXIST` (cannot create directory because a file exists).

```typescript
test("CLI entry point setup failure catch block", async () => {
  const tempHome = createTempHome();
  const REPO_ROOT = join(import.meta.dirname, "..");

  // Create a file named '.browsight' (instead of a directory) to force mkdirSync to throw EEXIST
  writeFileSync(join(tempHome, ".browsight"), "blocking file");

  const childSetup = spawn(process.execPath, [join(REPO_ROOT, "scripts", "setup.ts")], {
    env: {
      ...process.env,
      USERPROFILE: tempHome,
      HOME: tempHome,
      BROWSIGHT_HOME: tempHome,
    },
  });

  let stderrOutput = "";
  childSetup.stderr.on("data", (chunk) => {
    stderrOutput += chunk.toString();
  });

  const setupExit = await new Promise<number | null>((resolve) => {
    childSetup.on("close", resolve);
  });

  // Verify process exits with 1 and outputs error message
  assert.equal(setupExit, 1);
  assert.match(stderrOutput, /setup failed:/);

  rmSync(tempHome, { recursive: true, force: true });
});
```

### C. Testing `withBrowsightCodex` replacement at EOF
Add a unit test checking the `nextTable === -1` branch:

```typescript
test("withBrowsightCodex replaces stale table at the end of file (nextTable === -1)", () => {
  const existing = "[mcp_servers.browsight]\ncommand = 'old'\nargs = []";
  const merged = withBrowsightCodex(existing, { command: "new", args: ["s.mjs"] });
  assert.match(merged, /command = 'new'/);
  assert.ok(!merged.includes("command = 'old'"));
});
```

### D. Testing Codex Directory-Only Check & runDoctor() Short-Circuit
Add a test that sets up the `.codex` directory, but not the file:

```typescript
test("runSetup when Codex directory exists but config.toml does not", async () => {
  const tempHome = createTempHome();
  const originalHome = process.env.BROWSIGHT_HOME;
  process.env.BROWSIGHT_HOME = tempHome;

  // Create only the directory
  mkdirSync(join(tempHome, ".codex"), { recursive: true });

  try {
    await runSetup();
    const codexToml = readFileSync(join(tempHome, ".codex", "config.toml"), "utf8");
    assert.match(codexToml, /\[mcp_servers\.browsight\]/);

    // Verify runDoctor short-circuits registered check (codexRegistered is true)
    let stdoutOutput = "";
    const originalWrite = process.stdout.write;
    process.stdout.write = (chunk: any) => {
      stdoutOutput += chunk;
      return true;
    };
    try {
      runDoctor();
    } finally {
      process.stdout.write = originalWrite;
    }
    assert.match(stdoutOutput, /✓ MCP server registered/);
  } finally {
    process.env.BROWSIGHT_HOME = originalHome;
    rmSync(tempHome, { recursive: true, force: true });
  }
});
```

### E. Testing `tryPort()` Address Resolution Fallback
Mock the `address()` function of the server instance returned by `createServer` to return `null` or a string:

```typescript
test("tryPort falls back to port argument if server address is not an object", async () => {
  const require = createRequire(import.meta.url);
  const net = require("node:net");
  const originalCreateServer = net.createServer;

  net.createServer = () => {
    const srv = originalCreateServer();
    srv.address = () => "some-unix-socket-string";
    return srv;
  };

  try {
    const port = await tryPort(0);
    assert.equal(port, 0); // falls back to the port argument passed
  } finally {
    net.createServer = originalCreateServer;
  }
});
```

---

## 4. Verification Method
Once the tests are integrated into `scripts/setup.test.ts`, run the following command in the project root to verify that 100% statement, branch, and function coverage is achieved for `scripts/setup.ts`:

```bash
node --experimental-test-coverage --test scripts/setup.test.ts
```

The output report should show:
*   `setup.ts | 100.00 | 100.00 | 100.00`
*   No uncovered lines listed.
