# Original User Request

## 2026-06-30T04:38:25Z

You are responsible for writing unit tests using `node:test`, `assert`, and `jsdom` to achieve >= 80% coverage for the following Extension files:
1. `extension/src/perception/snapshot.ts`
2. `extension/src/service-worker.ts`

Working directory: `c:\Users\aen\Music\browsight-mcp`
`jsdom` is already installed. Use it to mock the DOM for `snapshot.ts`.
You will also need to heavily mock the global `chrome` API object for `service-worker.ts` to simulate extension events and storage access.
You may run `npm run test` to verify your coverage.
Report back when coverage for these 2 files is >= 80%. Do not git commit.
