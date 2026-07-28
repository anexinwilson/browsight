# Project structure

Browsight is an npm-workspaces monorepo with four packages.

| Directory | Responsibility |
| --- | --- |
| `extension/` | Manifest V3 extension, permission UI, page snapshots, and browser actions |
| `server/` | MCP server, local WebSocket bridge, output filtering, and tab formatting |
| `shared/` | Zod schemas and TypeScript types for bridge messages |
| `scripts/` | Setup, MCP client registration, and installation diagnostics |

## Runtime path

1. An MCP client starts the local server over stdio.
2. The server listens on `127.0.0.1` using the port generated during setup.
3. The extension connects and authenticates with the per-install token.
4. The extension checks the selected tab against the stored permission grant.
5. A content script reads or acts on the page.
6. The result returns through the extension and server to the MCP client.

The extension is the policy enforcement point. The server cannot grant access to a site.

## Main entry points

- `server/src/index.ts`: process entry point
- `server/src/mcp.ts`: MCP tool registration
- `server/src/bridge.ts`: authenticated WebSocket bridge
- `extension/src/service-worker.ts`: bridge client and request router
- `extension/src/content.ts`: page snapshot and action listener
- `shared/src/protocol.ts`: bridge schemas
- `scripts/setup.ts`: installer and doctor command

Implementation details are documented in [docs/DESIGN.md](docs/DESIGN.md). Planned work is tracked in [docs/ROADMAP.md](docs/ROADMAP.md).
