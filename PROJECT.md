# Project: browsight-mcp

## Architecture
browsight-mcp is a tool that exposes the user's Chrome session to an MCP client.
It consists of:
1. **MCP Server (Node.js)**: Listens for stdio from MCP clients, processes requests, strips secrets, and forwards requests to the Chrome extension.
2. **Chrome Extension (Manifest V3)**: Captures the active tab's DOM to build a semantic snapshot, executes actions (clicks, fills, scrolls, navigation), and manages permission boundaries.
3. **WebSocket Bridge**: Connects the MCP Server to the Chrome Extension using loopback WebSocket (`127.0.0.1`) with high-entropy token authentication.

## Code Layout
- `/.github/workflows/` — CI/CD pipelines (GitHub Actions)
- `/extension/` — Chrome extension source code
  - `src/service-worker.ts` — background script managing WebSocket bridge and tab messaging
  - `src/content.ts` — content script executing DOM snapshots and actions
  - `src/popup.ts` & `src/options.ts` — extension UI for permissions configuration
  - `src/perception/` — snapshot walker and accessibility-tree reconstruction logic
  - `src/acting/` — action settlement, diffing, and element resolution
  - `src/permissions/` — permission rules, storage, and host permissions management
- `/server/` — MCP server source code
  - `src/index.ts` — server entry point
  - `src/bridge.ts` — WebSocket bridge listener
  - `src/mcp.ts` — standard MCP tool definitions (`browser_read`, `browser_act`)
  - `src/extract.ts` — post-processing, secret stripping, token usage estimations, and login-wall checks
- `/shared/` — shared modules
  - `src/protocol.ts` — standard message formats and schema validation (Zod)
- `/scripts/` — setup and utility scripts
  - `src/setup.ts` — automatic environment configuration and system diagnostics ("doctor")

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | Secure GitHub Actions Workflows | Update workflows under `.github/workflows/` to use pinned commit SHAs and `--ignore-scripts`. | none | PLANNED |
| 2 | Refactor Extension Code | Refactor window/globalThis, Cognitive Complexity, nullish coalescing, and HTML access issues under `extension/`. | M1 | PLANNED |
| 3 | Modernize Scripts and Server | Address replaceAll, regex backtracking, String.raw, template nesting, and Object stringification under `server/` and `scripts/`. | M2 | PLANNED |
| 4 | Final Acceptance & E2E Validation | Pass 100% of standard tests and E2E test suite. Run adversarial Tier 5 tests and Forensic Auditor validation. | M3 | PLANNED |

## Interface Contracts
### Server ↔ Extension
Communication happens over WebSocket. Message contracts are defined in `/shared/src/protocol.ts`.
- **Handshake**: Extension connects and sends `{ type: "auth", token: string, extensionVersion: string }`.
- **Read**: Server sends `read.request`. Extension returns `read.response` containing `{ markdown: string, refs: object[], hasPasswordField: boolean }` or throws an error.
- **Act**: Server sends `act.request` containing reference, action, and optional value. Extension returns `act.response` containing `{ verdict: string, diff: object }` or throws an error.

### Service Worker ↔ Content Script
Communication happens over standard Chrome runtime messaging (`chrome.tabs.sendMessage`).
- **Snapshot request**: Background worker requests a semantic snapshot from the active tab's content script.
- **Action execution**: Background worker requests page actions from the active tab's content script.
