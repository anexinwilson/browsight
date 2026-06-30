# Handoff Report: Coverage Gaps & Testing Strategy for `scripts/setup.ts`

## 1. Observation
- **Coverage Run**: Executing `node --experimental-test-coverage --test scripts/setup.test.ts` in the project root yielded:
  ```
  ℹ ----------------------------------------------------------
  ℹ file      | line % | branch % | funcs % | uncovered lines
  ℹ ----------------------------------------------------------
  ℹ scripts   |        |          |         | 
  ℹ  setup.ts |  98.19 |    76.56 |   96.15 | 38-39 273-275
  ℹ ----------------------------------------------------------
  ```
- **Code Locations (NPX Context)**:
  - Lines 37-39 in `scripts/setup.ts`:
    ```typescript
    export function mcpNpxEntry(): McpEntry {
      return { command: "npx", args: ["-y", "browsight"] };
    }
    ```
  - Lines 101-105 in `scripts/setup.ts`:
    ```typescript
    function isNpxContext(): boolean {
      const p = SCRIPT_DIR.replace(/\\/g, "/");
      return p.includes("/_npx/") || p.includes("/.cache/node/");
    }
    ```
  - Line 202 in `scripts/setup.ts`:
    ```typescript
    const entry = npx ? mcpNpxEntry() : mcpServerEntry(SERVER_ENTRY);
    ```
- **Code Locations (Other Uncovered Lines)**:
  - Lines 272-275 in `scripts/setup.ts` (catch block for CLI errors):
    ```typescript
        } catch (err: unknown) {
          process.stderr.write(`setup failed: ${String(err)}\n`);
          process.exit(1);
        }
    ```
  - Lines 78-80 in `scripts/setup.ts` (`nextTable === -1` branch).
  - Lines 88-89 in `scripts/setup.ts` (`isCompiled` evaluation when true).
  - Lines 195-197 in `scripts/setup.ts` (`existsSync(EXTENSION_DIST_SRC)` when false).
  - Line 210-211 in `scripts/setup.ts` (Codex existence ternary operator fallback when file is missing but directory exists).
  - Lines 233-237 in `scripts/setup.ts` (short-circuiting when `codexRegistered` is true in `runDoctor()`).
  - Lines 242-243 in `scripts/setup.ts` (secondary manifest check in `runDoctor()`).
  - Line 144 in `scripts/setup.ts` (non-object address fallback in `tryPort()`).

## 2. Logic Chain
1. **Observation 1 (Coverage Run)** shows that `scripts/setup.ts` has uncovered lines 38-39 and 273-275, along with a branch coverage of 76.56%.
2. **Observation 2 (NPX Context Code Locations)** shows that the `mcpNpxEntry()` function is never executed, and `isNpxContext()` only ever returns `false`. This directly corresponds to the 38-39 uncovered lines and a major branch gap (the NPX ternary pathway is never exercised in `runSetup()`).
3. **Observation 3 (Other Uncovered Lines)** details why the remaining 23.44% of branch coverage is missing: the error catch block in the CLI entry point is never triggered, the TOML parser has an uncovered EOF table case, and several file existence conditions only evaluate to one boolean value in the test environment.
4. therefore, a comprehensive testing strategy must explicitly mock/simulate these file paths, conditions, and environment contexts to hit all statements, functions, and branches.

## 3. Caveats
- Since this is a read-only investigation, the proposed tests have not been merged into `scripts/setup.test.ts`.
- The dynamic import testing strategy for `isNpxContext` and `isCompiled` assumes the temporary mock directory structure matches the Node.js module resolution context for the imports used by `setup.ts`. Since `setup.ts` only uses standard library modules (`node:*`), this path-independent import is highly likely to work seamlessly without complex package/workspace configuration.

## 4. Conclusion
To achieve 100% test coverage for `scripts/setup.ts`, the test suite needs to be extended in `scripts/setup.test.ts` to include:
1. Direct unit tests for the `mcpNpxEntry()` function and `withBrowsightCodex()` EOF branch.
2. Path simulation (dynamic copying and importing) to verify `isNpxContext`, `isCompiled`, and the NPX-branch of `runSetup()`.
3. Process testing with artificial write blocks (using existing files to block directory creation) to trigger the `isMain` error catch block.
4. Parameter/mock injections for `tryPort()`'s server address fallback and `runDoctor()`'s Codex short-circuit paths.

Detailed descriptions of these tests are documented in `c:\Users\aen\Music\browsight-mcp\.agents\teamwork_preview_explorer_npx_coverage_1\analysis.md`.

## 5. Verification Method
1. Inspect the analysis report at `c:\Users\aen\Music\browsight-mcp\.agents\teamwork_preview_explorer_npx_coverage_1\analysis.md`.
2. After implementing the proposed tests in `scripts/setup.test.ts`, run the coverage tool command:
   ```bash
   node --experimental-test-coverage --test scripts/setup.test.ts
   ```
3. Confirm that the coverage results for `scripts/setup.ts` show 100% statement, branch, and function coverage.
