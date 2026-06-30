# Plan: achieve >=80% test coverage for snapshot.ts and service-worker.ts

## Goals
1. Implement new unit tests for `extension/src/perception/snapshot.ts` using `node:test`, `assert`, and `jsdom`.
2. Review/enhance existing unit tests in `extension/src/service-worker.test.ts` to ensure coverage is >= 80% for `extension/src/service-worker.ts`.
3. Run `npm run test` with coverage flags (or node's built-in experimental coverage) to measure coverage.
4. Verify correctness and completeness of both files' tests without hardcoding test assertions or cheating.

## Decomposition and Strategy
- **Step 1**: Check the current state of tests. Run the current test suite and see if it runs successfully and what the coverage is.
- **Step 2**: Create `extension/src/perception/snapshot.test.ts`. Mock the DOM via `jsdom` (since it's already installed), construct different nodes (text nodes, inputs, headings, iframes, interactive elements, etc.) to trigger all branches in `SnapshotBuilder`.
- **Step 3**: Review `extension/src/service-worker.test.ts` to see what branches/lines are not covered, and add more tests to it to achieve >= 80% coverage.
- **Step 4**: Run tests, check coverage, run audit/verification, report completion.
