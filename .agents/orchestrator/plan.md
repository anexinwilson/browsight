# Plan — Extension Unit Testing & Coverage Target

We need to achieve >= 80% unit test coverage for these 5 files:
1. `extension/src/content.ts`
2. `extension/src/messaging/act.ts`
3. `extension/src/messaging/common.ts`
4. `extension/src/messaging/tabs.ts`
5. `extension/src/acting/act.ts`

Using:
- `node:test` (built-in runner)
- `assert` (built-in assertion library)
- `jsdom` (mock DOM)
- Stubbing of global `chrome` object.

## Execution Plan
1. **Explore & Analyze**:
   - Spawn an `explorer` subagent to analyze the code paths, existing tests, and current test coverage of the 5 files.
   - Check how coverage is executed and measured in this repository (e.g. `node --experimental-test-coverage` or similar).
2. **Decompose Testing**:
   - Focus on one file at a time or write tests for related messaging files together.
   - Draft tests for:
     - `extension/src/messaging/common.ts`
     - `extension/src/messaging/act.ts`
     - `extension/src/messaging/tabs.ts`
     - `extension/src/acting/act.ts` (existing tests exist, expand if needed)
     - `extension/src/content.ts`
3. **Execute & Iterate**:
   - Spawn `worker` subagent to implement/update the unit tests.
   - Run tests and measure coverage. If coverage < 80%, identify uncovered branches/lines and write additional tests.
4. **Review & Audit**:
   - Spawn `reviewer` and `challenger` subagents to review correctness, edge cases, and robustness of the tests.
   - Run Forensic Auditor to verify integrity and ensure no tests are bypassed/hardcoded.
5. **Final Coverage Check**:
   - Confirm coverage >= 80% on all 5 files.
   - Report results back to the caller.
