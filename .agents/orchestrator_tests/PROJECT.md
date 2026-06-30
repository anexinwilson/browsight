# Project: browsight-mcp tests

## Architecture
- Target files:
  1. `extension/src/perception/snapshot.ts`: Walks DOM, generates accessible markdown representations, tracks elements. Needs jsdom mocking.
  2. `extension/src/service-worker.ts`: Listens to connection.json settings, makes websocket connections, handles communication with tab APIs, runs event listeners. Needs global chrome mock, fetch mock, and WebSocket mock.
- Test runner: `node --test`

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | snapshot_tests | Write unit tests for snapshot.ts in extension/src/perception/snapshot.test.ts | none | IN_PROGRESS |
| 2 | service_worker_tests | Enhance unit tests for service-worker.ts in extension/src/service-worker.test.ts | none | IN_PROGRESS |
| 3 | verify_coverage | Run tests and check line coverage is >= 80% for both files | M1, M2 | PLANNED |

## Interface Contracts
- None (this is purely unit testing code)
