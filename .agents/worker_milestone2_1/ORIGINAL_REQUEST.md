## 2026-06-30T04:16:03Z

You are a specialist implementation agent (teamwork_preview_worker).
Your working directory is: c:\Users\aen\Music\browsight-mcp\.agents\worker_milestone2_1

Your mission is to increase test coverage to >= 80% on `extension/src/service-worker.ts`, `extension/src/acting/act.ts`, and `scripts/setup.ts` using Node's native `node:test` runner and `jsdom`.

1. Initialize your BRIEFING.md and progress.md in your working directory.
2. Refactor `scripts/setup.ts` to prevent auto-execution when imported by tests:
   - Use the ESM main check:
     ```typescript
     import { pathToFileURL } from "node:url";
     // ...
     const isMain = process.argv[1] ? (import.meta.url === pathToFileURL(process.argv[1]).href) : false;
     if (isMain) {
       // doctor / setup execution
     }
     ```
   - Export `runSetup`, `runDoctor`, `tryPort`, `pickPort`.
3. Expand unit tests in `scripts/setup.test.ts`:
   - Mock process.stdout.write, process.stderr.write, and process.env.BROWSIGHT_HOME.
   - Mock filesystem reads/writes if needed to isolate configuration tests.
   - Test `tryPort` and `pickPort` behavior, simulating net server listening and port errors (port-busy conflict).
   - Test `runSetup` and `runDoctor` execution outcomes.
4. Expand unit tests in `extension/src/acting/act.test.ts`:
   - Test select dropdown inputs (`fillSelect`).
   - Test editable div text insertions (`fillEditable`).
   - Test scrolling methods (`scrollViewport` and `loadMore`).
   - Test click dispatching logic (`dispatchClick`).
   - Test `performAct` switch cases (click, scroll, navigate, and validation/error paths).
5. Create `extension/src/service-worker.test.ts` to test `extension/src/service-worker.ts`:
   - Mock global `chrome` API object (`chrome.runtime.getURL`, `chrome.runtime.getManifest`, `chrome.runtime.onInstalled.addListener`, `chrome.runtime.onStartup.addListener`, `chrome.alarms.create`, `chrome.alarms.onAlarm.addListener`).
   - Mock `fetch` and global `WebSocket` to simulate websocket connections, messages, and disconnection/errors.
   - Assert correct websocket payload generation, auth message handshake, and routing of messages to `handleRead`, `handleAct`, `handleTabs`.
6. Run `npm run typecheck`, `npm run lint` (`biome check`), and `node --experimental-test-coverage --test "**/*.test.ts"` to check type-safety, styling compliance, and test execution.
7. Run coverage command `npm run test -- --experimental-test-coverage --test-reporter=lcov` (or equivalent) to generate `lcov.info` and ensure that `service-worker.ts`, `act.ts`, and `setup.ts` have >= 80% line coverage.
8. Make a local git commit of your changes. DO NOT push to the remote repository.
9. Write a comprehensive handoff report `handoff.md` showing the exact commands run, test pass results, and coverage metrics.

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A Forensic Auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Strict Local-Only Constraint: Do NOT run `git push`. All commits must remain local. You may run `git add` and `git commit` to save progress locally, but you must never push to the remote repository.
