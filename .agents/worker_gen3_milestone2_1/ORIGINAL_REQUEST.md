## 2026-06-30T04:42:19Z

You are the Test Coverage Developer.
Your working directory is: c:\Users\aen\Music\browsight-mcp\.agents\worker_gen3_milestone2_1
You must write your implementation and verification report to `handoff.md` inside your working directory.

Task:
Implement and expand unit tests using `node:test` and `assert` for:
1. `server/src/index.ts`: Write a new test file `server/src/index.test.ts`. Use process isolation (Option B from Explorer report: spawning `index.ts` with process.execPath and controlled BROWSIGHT_HOME/USERPROFILE env vars) to test:
   - Graceful failure when config is missing
   - Standard boot and response to JSON-RPC initialization when config is present.
2. `server/src/bridge.ts`: Add tests to `server/src/bridge.test.ts` for:
   - `actActiveTab` and `listTabs` routing and responses.
   - Auth timeout and token mismatch/rejection.
   - Mid-request disconnect and request timeout.
3. `scripts/setup.ts`: Add tests to `scripts/setup.test.ts` for:
   - `pickPort` secondary failure (where both attempts reject).
   - `readJson` recovery from malformed JSON.
   - `tomlString` escaped quotes coverage (single quotes path, double quotes arg).
   - CLI entry point integration (`setup.ts` child process execution for doctor/setup).

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A Forensic Auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Verification:
- Run `npm run test` and capture the stdout.
- Check line coverage of:
  - `server/src/index.ts`
  - `server/src/bridge.ts`
  - `server/src/extract.ts`
  - `scripts/setup.ts`
- Ensure line coverage for each is >= 80%.
- Document the exact command used, test results, and final coverage numbers in your handoff report. Do not git commit.
