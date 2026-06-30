# Handoff Report - NPX Refactoring Coverage Investigation

## 1. Observation
We observed the test suite coverage by running the following command in the workspace root:
```powershell
node --experimental-test-coverage --test scripts/setup.test.ts
```

This outputted the following coverage report:
```
ℹ start of coverage report
ℹ ----------------------------------------------------------
ℹ file      | line % | branch % | funcs % | uncovered lines
ℹ ----------------------------------------------------------
ℹ scripts   |        |          |         | 
ℹ  setup.ts |  98.19 |    76.56 |   96.15 | 38-39 273-275
ℹ ----------------------------------------------------------
ℹ all files |  98.19 |    76.56 |   96.15 | 
ℹ ----------------------------------------------------------
ℹ end of coverage report
```

Upon looking inside `scripts/setup.ts` at the specified uncovered lines and branch structures:
* **Lines 38-39**: 
  ```typescript
  export function mcpNpxEntry(): McpEntry {
    return { command: "npx", args: ["-y", "browsight"] };
  }
  ```
  Is never imported or tested in `scripts/setup.test.ts`.
* **Lines 273-275**:
  ```typescript
  } catch (err: unknown) {
    process.stderr.write(`setup failed: ${String(err)}\n`);
    process.exit(1);
  }
  ```
  Is the CLI entry point catch block, which is never triggered in existing CLI tests.
* **Line 101-105** (`isNpxContext`):
  ```typescript
  function isNpxContext(): boolean {
    const p = SCRIPT_DIR.replace(/\\/g, "/");
    return p.includes("/_npx/") || p.includes("/.cache/node/");
  }
  ```
  The branches returning `true` are not hit because `SCRIPT_DIR` resolves to the local development environment path.
* **Line 89** (`isCompiled`):
  ```typescript
  const PKG_ROOT = isCompiled ? resolve(SCRIPT_DIR, "..", "..") : resolve(SCRIPT_DIR, "..");
  ```
  The compiled path ternary branch is not covered.

---

## 2. Logic Chain
1. *Observation*: The experimental test coverage command identified line coverage of 98.19% with specific uncovered lines `38-39` and `273-275`.
2. *Observation*: `mcpNpxEntry` and the `catch` block on `273-275` represent functions and branches added or modified during CLI and NPX runtime environments.
3. *Reasoning*:
   * To cover `mcpNpxEntry()`, we must import and invoke it in the unit tests.
   * To cover the `catch` block on lines 273-275, we must spawn `setup.ts` in a way that triggers a filesystem error (e.g. by setting `BROWSIGHT_HOME` to a file path so `mkdirSync` fails with `ENOTDIR`).
   * To cover the branches of `isNpxContext` and `isCompiled` which rely on the location of `setup.ts` (`import.meta.url`), we must copy `setup.ts` to temporary directories structured with `_npx`, `.cache/node`, and `dist` subfolders, dynamically import them in-process, and execute their `runSetup` methods.
4. *Conclusion*: A testing strategy targeting these specific paths will cover all remaining lines and branches, achieving 100% test coverage.

---

## 3. Caveats
No caveats. The proposed tests run fully in-process or via lightweight CLI spawns, leveraging Node.js 24's native support for TypeScript files and dynamic imports.

---

## 4. Conclusion
The coverage gaps in `scripts/setup.ts` can be completely resolved by adding:
1. A unit test directly validating `mcpNpxEntry`.
2. Dynamic import tests simulating `_npx`, `.cache/node`, and `dist/` module environments.
3. A CLI integration test that triggers setup failure.
4. Additional unit tests covering configuration reuse, `tomlString` dual-quote escapes, `tryPort` fallback addresses, and Codex registered doctor status.

These proposed tests are defined in detail in the `analysis.md` report.

---

## 5. Verification Method
To independently verify:
1. Apply the test cases described in `analysis.md` to `scripts/setup.test.ts`.
2. Execute the test runner with experimental coverage:
   ```powershell
   node --experimental-test-coverage --test scripts/setup.test.ts
   ```
3. Verify that the line coverage is reported as `100.00%` and uncovered lines is empty.
