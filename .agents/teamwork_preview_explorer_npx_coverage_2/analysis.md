# Coverage Analysis and Test Strategy for `scripts/setup.ts`

## Executive Summary
This report analyzes the test coverage of `scripts/setup.ts` and identifies gaps resulting from the recent 'npx' refactoring. It proposes a concrete, low-overhead testing strategy to cover all untested lines and branches, enabling the project to achieve 100% test coverage for this bootstrap script.

---

## 1. Direct Observations & Coverage Status

Running the test suite with experimental coverage (`node --experimental-test-coverage --test scripts/setup.test.ts`) yields the following baseline:

* **Line Coverage**: 98.19%
* **Branch Coverage**: 76.56%
* **Function Coverage**: 96.15%
* **Uncovered Lines**: `38-39` and `273-275`

### Verified Coverage Gaps

#### Gap A: Uncovered Line 38-39 (`mcpNpxEntry`)
```typescript
37: export function mcpNpxEntry(): McpEntry {
38:   return { command: "npx", args: ["-y", "browsight"] };
39: }
```
* **Status**: Untested. The function is exported but never imported or called in `scripts/setup.test.ts`.

#### Gap B: Uncovered Line 273-275 (CLI Catch Block)
```typescript
272:     } catch (err: unknown) {
273:       process.stderr.write(`setup failed: ${String(err)}\n`);
274:       process.exit(1);
275:     }
```
* **Status**: Untested. The integration tests spawn `setup.ts` using `process.execPath`, but they only test successful setup and doctor execution. No test triggers a configuration failure in CLI mode.

#### Gap C: Uncovered Branch `isNpxContext` True Path (Lines 101-105)
```typescript
101: function isNpxContext(): boolean {
102:   // npx installs packages under a path containing _npx. A local repo clone never has this.
103:   const p = SCRIPT_DIR.replace(/\\/g, "/");
104:   return p.includes("/_npx/") || p.includes("/.cache/node/");
105: }
```
* **Status**: Untested. Since the unit tests run from the repository root, `SCRIPT_DIR` resolves to `.../browsight-mcp/scripts`, which does not contain `_npx` or `.cache/node`. Therefore, the branches verifying NPX-based setup are never traversed.

#### Gap D: Uncovered Branch `isCompiled` True Path (Lines 88-89)
```typescript
88: const isCompiled = /[/\\]dist$/.test(SCRIPT_DIR);
89: const PKG_ROOT = isCompiled ? resolve(SCRIPT_DIR, "..", "..") : resolve(SCRIPT_DIR, "..");
```
* **Status**: Untested. The unit tests import `setup.ts` from its source path (`/scripts`), so `isCompiled` remains `false`.

#### Gap E: Uncovered Branch `runSetup` Config Reuse (Lines 185-187)
```typescript
185:   const token = typeof existing.token === "string" ? existing.token : generateToken();
186:   const port = typeof existing.port === "number" ? existing.port : await pickPort(8137);
187:   const host = typeof existing.host === "string" ? existing.host : "127.0.0.1";
```
* **Status**: Untested. Tests only execute `runSetup` once per clean directory, leaving the fallback path (generating new tokens/ports) covered but the reuse path untested.

#### Gap F: Uncovered Branch `tomlString` Quote Escape (Line 57)
```typescript
55: function tomlString(value: string): string {
56:   return value.includes("'")
57:     ? `"${value.replaceAll("\\", BACKSLASH_ESCAPED).replaceAll('"', QUOTE_ESCAPED)}"`
58:     : `'${value}'`;
```
* **Status**: Untested. The replacement `replaceAll('"', QUOTE_ESCAPED)` inside the true branch is never triggered because the test input containing a single quote does not contain a double quote.

#### Gap G: Uncovered Branch `tryPort` Fallback (Line 144)
```typescript
144:       const chosen = typeof addr === "object" && addr ? addr.port : port;
```
* **Status**: Untested. `srv.address()` always returns a valid `AddressInfo` object during the test run, so the fallback to `port` is never hit.

---

## 2. Proposed Testing Strategy

To achieve 100% line and branch coverage without modifying `scripts/setup.ts`, we propose adding the following tests to `scripts/setup.test.ts`:

### 1. Unit Test for `mcpNpxEntry`
Directly import and assert the return values of the exported `mcpNpxEntry` function.
```typescript
test("mcpNpxEntry returns correct command and arguments for npx", () => {
  const entry = mcpNpxEntry();
  assert.equal(entry.command, "npx");
  assert.deepEqual(entry.args, ["-y", "browsight"]);
});
```

### 2. In-Process Context Isolation via Dynamic Imports
To test `isNpxContext` and `isCompiled` without polluting the filesystem permanently or spawning processes:
* Create temporary directories mimicking NPX execution paths (e.g. `scratch/_npx/` and `scratch/.cache/node/`) and build directories (e.g. `scratch/dist/`).
* Copy `scripts/setup.ts` into these folders.
* Dynamically import these isolated copies using Node's native `import()` in Node 24.
* Trigger `runSetup()` from the dynamic imports to verify configuration changes.

Example for testing `isNpxContext`:
```typescript
test("isNpxContext handles _npx and .cache/node paths correctly", async () => {
  const tempHome = createTempHome();
  const originalHome = process.env.BROWSIGHT_HOME;
  process.env.BROWSIGHT_HOME = tempHome;

  // Create temporary _npx mock folder
  const npxDir = join(process.cwd(), "scratch", "_npx");
  mkdirSync(npxDir, { recursive: true });
  const npxScriptPath = join(npxDir, "setup_mock.ts");
  
  // Copy setup.ts to _npx folder
  const originalContent = readFileSync(join(process.cwd(), "scripts", "setup.ts"), "utf8");
  writeFileSync(npxScriptPath, originalContent);

  try {
    const { runSetup } = await import(pathToFileURL(npxScriptPath).href);
    await runSetup();
    
    // Check that npx entry was written instead of node entry
    const claudeJson = JSON.parse(readFileSync(join(tempHome, ".claude.json"), "utf8"));
    assert.equal(claudeJson.mcpServers.browsight.command, "npx");
    assert.deepEqual(claudeJson.mcpServers.browsight.args, ["-y", "browsight"]);
  } finally {
    process.env.BROWSIGHT_HOME = originalHome;
    rmSync(tempHome, { recursive: true, force: true });
    rmSync(npxDir, { recursive: true, force: true });
  }
});
```

### 3. CLI Error Handling Integration Test
Trigger a setup failure in CLI mode by passing a `BROWSIGHT_HOME` pointing to an existing file rather than a directory. This will cause `mkdirSync` to throw `ENOTDIR` and trigger the catch block.
```typescript
test("CLI entry point handles setup failure", async () => {
  const tempHome = createTempHome();
  const REPO_ROOT = join(import.meta.dirname, "..");
  const tempFile = join(tempHome, "file_blocking_dir");
  writeFileSync(tempFile, "not a directory");

  const childSetup = spawn(process.execPath, [join(REPO_ROOT, "scripts", "setup.ts")], {
    env: {
      ...process.env,
      USERPROFILE: tempHome,
      HOME: tempHome,
      BROWSIGHT_HOME: tempFile,
    },
  });

  let stderrOutput = "";
  childSetup.stderr.on("data", (chunk) => {
    stderrOutput += chunk.toString();
  });

  const setupExit = await new Promise<number | null>((resolve) => {
    childSetup.on("close", resolve);
  });

  assert.equal(setupExit, 1);
  assert.match(stderrOutput, /setup failed:/);

  rmSync(tempHome, { recursive: true, force: true });
});
```

### 4. Configuration Reuse Test
Initialize a valid `bridge.json` before calling `runSetup` to verify that existing token, port, and host values are correctly reused.
```typescript
test("runSetup reuses existing token, port, and host from bridge.json", async () => {
  const tempHome = createTempHome();
  const originalHome = process.env.BROWSIGHT_HOME;
  process.env.BROWSIGHT_HOME = tempHome;

  try {
    const bridgeDir = join(tempHome, ".browsight");
    mkdirSync(bridgeDir, { recursive: true });
    const existingConfig = {
      token: "existing-test-token-12345",
      port: 9999,
      host: "127.0.0.2"
    };
    writeFileSync(join(bridgeDir, "bridge.json"), JSON.stringify(existingConfig));

    await runSetup();

    const bridgeJson = JSON.parse(readFileSync(join(bridgeDir, "bridge.json"), "utf8"));
    assert.equal(bridgeJson.token, "existing-test-token-12345");
    assert.equal(bridgeJson.port, 9999);
    assert.equal(bridgeJson.host, "127.0.0.2");
  } finally {
    process.env.BROWSIGHT_HOME = originalHome;
    rmSync(tempHome, { recursive: true, force: true });
  }
});
```

### 5. `tomlString` Double Quote Escape Test
Provide a value with both single and double quotes to test the replacement branch of `tomlString`.
```typescript
test("tomlString escaped quotes coverage with both single and double quotes", () => {
  const block = browsightCodexBlock({
    command: 'C:\\path\'with\'quote"and"double',
    args: [],
  });
  assert.match(block, /command = "C:\\\\path'with'quote\\"and\\"double"/);
});
```

### 6. `tryPort` Address Mocking Test
Mock `net.createServer` to return a server whose `address()` method returns `null`, forcing `tryPort` to fall back to the default port.
```typescript
test("tryPort fallback when address is null", async () => {
  const require = createRequire(import.meta.url);
  const net = require("node:net");
  const originalCreateServer = net.createServer;
  net.createServer = () => {
    const srv = originalCreateServer();
    srv.address = () => null;
    return srv;
  };
  try {
    const port = await tryPort(12345);
    assert.equal(port, 12345);
  } finally {
    net.createServer = originalCreateServer;
  }
});
```

### 7. Codex Registration Integration Test
Add a test case where a Codex configuration is written and then read by `runDoctor` to verify the `codexRegistered` status path.
```typescript
test("runDoctor checks status of successful setup with codex registered", async () => {
  const tempHome = createTempHome();
  const originalHome = process.env.BROWSIGHT_HOME;
  process.env.BROWSIGHT_HOME = tempHome;

  mkdirSync(join(tempHome, ".codex"), { recursive: true });

  const originalWrite = process.stdout.write;
  let stdoutOutput = "";
  process.stdout.write = (chunk: any) => {
    stdoutOutput += chunk;
    return true;
  };

  try {
    await runSetup();
    stdoutOutput = ""; // reset
    runDoctor();
  } finally {
    process.stdout.write = originalWrite;
    process.env.BROWSIGHT_HOME = originalHome;
    rmSync(tempHome, { recursive: true, force: true });
  }

  assert.match(stdoutOutput, /✓ MCP server registered in a client config/);
});
```
