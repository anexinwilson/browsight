# Testing Plan — Gen 3

This plan targets achieving >= 80% test coverage for:
1. `server/src/index.ts`
2. `server/src/bridge.ts`
3. `server/src/extract.ts`
4. `scripts/setup.ts`

## Milestones

### Milestone 1: Exploration & Diagnostics
- Spawn an Explorer to investigate the structure, code paths, and existing test coverage of the four files.
- Determine specific test coverage gaps for each file.
- Formulate a strategy to test `server/src/index.ts` (dealing with its top-level immediate execution on import).

### Milestone 2: Implement & Expand Tests
- Spawn a Worker to implement unit tests in:
  - `server/src/index.test.ts` (new file)
  - `server/src/bridge.test.ts` (expansion)
  - `server/src/extract.test.ts` (expansion)
  - `scripts/setup.test.ts` (expansion)
- Ensure all Node `fs` and `os` functions are properly mocked using `mock.method` as needed to avoid actual file system mutation.
- Achieve >= 80% line coverage for all four files.

### Milestone 3: Review and Verification
- Spawn a Reviewer to verify test correctness, lint compliance, and check for any code smells.
- Spawn a Challenger to run tests independently and confirm coverage metrics are met.
- Spawn a Forensic Auditor to ensure no cheating or hardcoding of test results.

### Milestone 4: Aggregation and Reporting
- Synthesize findings and verification reports.
- Report completion back to the main agent with detailed coverage metrics.
