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
