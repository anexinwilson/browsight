# Handoff Report — NPX Refactoring Coverage Investigation

## 1. Observation
- The command `node --experimental-test-coverage --test scripts/setup.test.ts` was executed.
- The coverage output returned:
  ```
  scripts   |        |          |         | 
   setup.ts |  98.19 |    76.56 |   96.15 | 38-39 273-275
  ```
- Uncovered lines:
  - Lines `38-39`:
    ```typescript
    export function mcpNpxEntry(): McpEntry {
      return { command: "npx", args: ["-y", "browsight"] };
    }
    ```
  - Lines `273-275`:
    ```typescript
    process.stderr.write(`setup failed: ${String(err)}\n`);
    process.exit(1);
    ```
- The private helper function `isNpxContext` is defined on line 101:
  ```typescript
  function isNpxContext(): boolean {
    const p = SCRIPT_DIR.replace(/\\/g, "/");
    return p.includes("/_npx/") || p.includes("/.cache/node/");
  }
  ```
  It has no tests exercising the `true` branches of the OR condition.
- The `isCompiled` flag on line 88 checks `/[/\\]dist$/.test(SCRIPT_DIR)`, which is only `true` when run from a compiled dist directory. This is not exercised.
- In `tomlString` (line 55):
  ```typescript
  function tomlString(value: string): string {
    return value.includes("'")
      ? `"${value.replaceAll("\\", BACKSLASH_ESCAPED).replaceAll('"', QUOTE_ESCAPED)}"`
      : `'${value}'`;
  }
  ```
  There is no test with a value containing both a single quote and a double quote.
- In `withBrowsightCodex` (line 70), there is no test case for `nextTable === -1` where the browsight table being replaced is the last table in the file.
- In `runDoctor` (line 229), the branch where `codexRegistered` is `true` is never evaluated as the reason for registering browsight in client configs.

## 2. Logic Chain
1. *Observation 1*: The coverage report shows that lines `38-39` and `273-275` are uncovered.
2. *Observation 2*: `mcpNpxEntry` (lines 38-39) is called when `isNpxContext()` returns `true` inside `runSetup()`.
3. *Observation 3*: Since tests run from local development directories, `SCRIPT_DIR` contains neither `_npx` nor `.cache/node`. Therefore, `isNpxContext` always returns `false`.
4. *Observation 4*: To test this behavior without modifying `setup.ts` (which is read-only), we can leverage the fact that `setup.ts` has no relative package imports.
5. *Inference*: Copying `setup.ts` to a temporary path containing `_npx` or `.cache/node` and dynamically importing it will allow us to run `runSetup()` in a simulated NPX context, executing lines `38-39`.
6. *Observation 5*: Similarly, copying `setup.ts` to a path ending in `/dist/` will make `isCompiled` evaluate to `true`, covering the compiled directory resolution logic (line 89).
7. *Observation 6*: To cover the CLI exit `catch` block (lines 273-275), we can create a file (rather than a directory) at the expected `.browsight` path prior to running the spawned CLI setup. This causes `mkdirSync` to fail and throw an error, triggering the catch block.
8. *Observation 7*: Adding test inputs containing both single and double quotes to `tomlString` tests will trigger the `replaceAll` branches. Adding a test where a stale browsight table is the last block in TOML triggers the `nextTable === -1` branch. Initializing a mock Codex file before checking status will cover `codexRegistered = true`.
9. *Conclusion*: By implementing these 5 targeted test cases, we can achieve 100% line and branch coverage.

## 3. Caveats
- This investigation assumes that the Node.js test runner (`node --test`) and dynamic imports are supported in the environment (which is validated by the running suite on Node 24).
- The dynamic import approach depends on `setup.ts` not introducing any relative imports in the future. If relative imports are added, the mock path method would require mirroring the folder structure of those relative imports.

## 4. Conclusion
We have identified 2 uncovered statements (lines 38-39 and 273-275) and multiple uncovered branches (in `isNpxContext`, `runSetup`, `isCompiled`, `tomlString`, `withBrowsightCodex`, and `runDoctor`). We have proposed a non-intrusive testing strategy using dynamic path-based imports and environment mocks to achieve 100% statement and branch coverage.

## 5. Verification Method
To verify the findings and the proposed strategy:
1. Run the test coverage tool using:
   ```bash
   node --experimental-test-coverage --test scripts/setup.test.ts
   ```
2. Verify that the line coverage is `98.19%` and branch coverage is `76.56%`.
3. Add the proposed tests to `scripts/setup.test.ts`.
4. Run the coverage command again and verify that it reaches `100.00%` for both lines and branches.
