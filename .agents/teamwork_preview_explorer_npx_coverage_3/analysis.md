# NPX Coverage Analysis Report — scripts/setup.ts

## Executive Summary
This analysis identifies the test coverage gaps for the recent `npx` refactoring in `scripts/setup.ts` and proposes a comprehensive, non-intrusive testing strategy to achieve **100% statement and branch coverage**. 

Using Node.js's native coverage tool (`node --experimental-test-coverage`), we observed that `scripts/setup.ts` currently stands at **98.19% statement coverage** and **76.56% branch coverage**. The uncovered statements are lines `38-39` (the new `mcpNpxEntry` function) and lines `273-275` (the setup failure `catch` block in the CLI entry point). Additionally, several key logical branches (such as the `_npx` and `.cache/node` path matching inside `isNpxContext()`, compiled asset path resolution, and specific TOML parsing edge cases) are not exercised by the current tests.

---

## Detailed Coverage Gap Breakdown

### 1. Uncovered Statements
| Line Numbers | Code Snippet | Reason for Gap |
| --- | --- | --- |
| **38–39** | `return { command: "npx", args: ["-y", "browsight"] };` (inside `mcpNpxEntry`) | The helper function `mcpNpxEntry` is never imported, invoked, or tested. |
| **273–275** | `process.stderr.write(\`setup failed: \${String(err)}\\n\`);\nprocess.exit(1);` | The error handler in the main CLI entry point is never triggered because the integration tests only execute successful setup processes. |

### 2. Uncovered Branches (Branch Coverage: 76.56%)
| Component | Affected Code / Logic | Reason for Gap |
| --- | --- | --- |
| **`isNpxContext()`** | `p.includes("/_npx/")` and `p.includes("/.cache/node/")` | The tests run from a local repository check-out, so `SCRIPT_DIR` never contains these segments, making both OR conditions always evaluate to `false`. |
| **`runSetup()`** | `const entry = npx ? mcpNpxEntry() : ...` | Because `isNpxContext()` is always `false`, the `npx` path (which registers the server via NPX rather than using local built paths) is never executed. |
| **`isCompiled`** | `const PKG_ROOT = isCompiled ? resolve(SCRIPT_DIR, "..", "..") : ...` | When running tests directly from source, `isCompiled` resolves to `false`, meaning the compiled root resolution logic is never tested. |
| **`tomlString()`** | `value.replaceAll('"', QUOTE_ESCAPED)` inside single-quote wrapper branch | Tested paths containing single quotes `'` never contain double quotes `"`, leaving the double-quote replacement logic unexercised. |
| **`withBrowsightCodex()`**| `const tail = nextTable === -1 ? "" : ...` | The test replacing a stale browsight table always puts another table (`[mcp_servers.keep]`) after it, so the `nextTable === -1` branch is never covered. |
| **`runDoctor()`** | `codexRegistered = existsSync(codexPath) && ...` | In the Doctor tests, the Codex configuration is not initialized or mocked, meaning the logic path that validates registration *solely* via Codex is never exercised. |

---

## Proposed Testing Strategy

To achieve 100% statement and branch coverage without modifying the production script (maintaining its read-only status), the following test cases should be added to `scripts/setup.test.ts`:

### 1. Testing NPX & Compiled contexts via Dynamic Path Mocking
Because `setup.ts` is fully self-contained and imports only native Node modules (`node:crypto`, `node:fs`, etc.), we can copy `setup.ts` to temporary mock directory structures and dynamically import them. This allows us to alter `import.meta.url` (and thus `SCRIPT_DIR`) without modifying the original source code.

```typescript
test("npx context detection and setup execution", async () => {
  const tempHome = createTempHome();
  const originalHome = process.env.BROWSIGHT_HOME;
  process.env.BROWSIGHT_HOME = tempHome;

  // Create a directory containing _npx to simulate NPX execution path
  const npxDir = join(tempHome, "_npx");
  mkdirSync(npxDir, { recursive: true });
  const mockSetupPath = join(npxDir, "setup.ts");
  writeFileSync(mockSetupPath, readFileSync("scripts/setup.ts"));

  // Setup a mock client configuration folder
  mkdirSync(join(tempHome, ".cursor"), { recursive: true });
  writeFileSync(join(tempHome, ".claude.json"), JSON.stringify({ mcpServers: {} }));

  const originalWrite = process.stdout.write;
  let stdoutOutput = "";
  process.stdout.write = (chunk: any) => {
    stdoutOutput += chunk;
    return true;
  };

  try {
    // Dynamic import to execute setup in the mock npx directory context
    const npxSetup = await import(pathToFileURL(mockSetupPath).href);
    await npxSetup.runSetup();
  } finally {
    process.stdout.write = originalWrite;
    if (originalHome) {
      process.env.BROWSIGHT_HOME = originalHome;
    } else {
      process.env.BROWSIGHT_HOME = undefined;
    }
  }

  // Assertions: Verify it wrote the npx command instead of the local server path
  const claudeJson = JSON.parse(readFileSync(join(tempHome, ".claude.json"), "utf8"));
  assert.deepEqual(claudeJson.mcpServers.browsight, {
    command: "npx",
    args: ["-y", "browsight"],
  });

  rmSync(tempHome, { recursive: true, force: true });
});

test("compiled context detection", async () => {
  const tempHome = createTempHome();
  
  // Create a directory ending with dist to trigger isCompiled = true
  const distDir = join(tempHome, "dist");
  mkdirSync(distDir, { recursive: true });
  const mockSetupPath = join(distDir, "setup.ts");
  writeFileSync(mockSetupPath, readFileSync("scripts/setup.ts"));

  const compiledSetup = await import(pathToFileURL(mockSetupPath).href);
  
  // Verify that it resolved PKG_ROOT successfully without throwing
  assert.ok(compiledSetup.mcpServerEntry);
  
  rmSync(tempHome, { recursive: true, force: true });
});
```

### 2. Testing Full Quote Escaping in TOML
We add a test containing both single and double quotes, along with backslashes, to cover the replacement branch in `tomlString()`.

```typescript
test("tomlString fully escapes quotes and backslashes when single quotes are present", () => {
  const block = browsightCodexBlock({
    command: `C:\\path'with'quote"and"double\\quotes`,
    args: [],
  });
  // Must wrap in double quotes and escape all backslashes and double quotes
  assert.match(block, /command = "C:\\\\path'with'quote\\\"and\\\"double\\\\quotes"/);
});
```

### 3. Testing Codex Replacement when Browsight is the Last Table
We add a test where `[mcp_servers.browsight]` is the last table in the file (or the only table).

```typescript
test("withBrowsightCodex replaces stale browsight table when it is the last table", () => {
  const existing = "[mcp_servers.browsight]\ncommand = 'old'\nargs = []\n";
  const merged = withBrowsightCodex(existing, { command: "new", args: ["s.mjs"] });
  assert.ok(merged.includes("command = 'new'"));
  assert.ok(!merged.includes("command = 'old'"));
  assert.ok(merged.endsWith("args = ['s.mjs']\n"));
});
```

### 4. Testing Doctor Validation Solely via Codex Registration
We add a test where only the Codex configuration has browsight registered, and verify that the Doctor reports success.

```typescript
test("runDoctor checks status of successful setup with Codex registered", async () => {
  const tempHome = createTempHome();
  const originalHome = process.env.BROWSIGHT_HOME;
  process.env.BROWSIGHT_HOME = tempHome;

  // Create .codex folder and empty config.toml
  mkdirSync(join(tempHome, ".codex"), { recursive: true });
  writeFileSync(join(tempHome, ".codex", "config.toml"), "");

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
    if (originalHome) {
      process.env.BROWSIGHT_HOME = originalHome;
    } else {
      process.env.BROWSIGHT_HOME = undefined;
    }
  }

  // Verify registration reports success
  assert.match(stdoutOutput, /✓ MCP server registered in a client config/);
  
  rmSync(tempHome, { recursive: true, force: true });
});
```

### 5. Testing CLI Error Handling (CLI Exit Catch Block)
To cover the `catch` block on lines `273–275`, we write a test that forces `runSetup()` to fail when running under a spawned CLI process. We achieve this by placing a file (instead of a directory) at the path `.browsight`, which causes `mkdirSync` to throw an `EEXIST` error when it attempts to create the configuration directory.

```typescript
test("CLI entry point integration - setup failure handling", async () => {
  const tempHome = createTempHome();
  const REPO_ROOT = join(import.meta.dirname, "..");

  // Force writeJson/mkdirSync to fail by placing a file at .browsight
  mkdirSync(tempHome, { recursive: true });
  writeFileSync(join(tempHome, ".browsight"), "not a directory");

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

  assert.equal(setupExit, 1);
  assert.match(stderrOutput, /setup failed:/);

  rmSync(tempHome, { recursive: true, force: true });
});
```

---

## Verification Plan
1. Apply the proposed test cases to `scripts/setup.test.ts`.
2. Run coverage checks with:
   ```bash
   node --experimental-test-coverage --test scripts/setup.test.ts
   ```
3. Confirm that line coverage for `scripts/setup.ts` reaches **100%** and branch coverage reaches **100%**.
