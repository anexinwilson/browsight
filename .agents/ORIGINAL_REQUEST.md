# Original User Request

## Request — 2026-06-30T04:38:25+05:30

You are responsible for writing unit tests using `node:test` (and `assert`) to achieve >= 80% coverage for the following server and script files:
1. `server/src/index.ts`
2. `server/src/bridge.ts`
3. `server/src/extract.ts`
4. `scripts/setup.ts`

Working directory: `c:\Users\aen\Music\browsight-mcp`
You may run `npm run test` to verify your coverage (look at the `lcov.info` output or standard test output).
Mock the Node `fs` and `os` functions using `mock.method` as needed to avoid actual file system mutation during testing.
Report back when coverage for these 4 files is >= 80%. Do not git commit.

## Follow-up — 2026-06-30T17:17:21Z

# Teamwork Project Prompt — Draft

> Status: Launched
> Goal: Craft prompt → get user approval → delegate to teamwork_preview

Audit the test suite for the `browsight` project to ensure the recent `npx` refactoring in `scripts/setup.ts` is fully covered, and fix any coverage gaps.

Working directory: c:\Users\aen\Music\browsight-mcp

## Requirements

### R1. Audit `npx` test coverage
The team must run coverage reports specifically targeting `scripts/setup.ts` to see if the new `npx` (and local path fallback) logic is actually being tested.

### R2. Write missing tests
Write new unit tests using `node:test` in `scripts/setup.test.ts` to cover any uncovered lines in the setup script, specifically the new `extensionHome` and path resolution logic.

## Acceptance Criteria

### Test Coverage
- [ ] Running `npm run test -- --experimental-test-coverage` shows 100% coverage for `scripts/setup.ts`.
- [ ] All 112+ tests pass successfully.
