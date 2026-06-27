# Contributing to browsight

## Prerequisites

- Node 24 (LTS) — see `.nvmrc`.
- Google Chrome.

## Setup

```
npm install
npm run build        # builds the server and the extension
npm run setup        # registers the server with your MCP client and prints the next steps
```

Then load the extension into Chrome:

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select `extension/dist`.

Restart your MCP client; `browser_read` should now be available.

## Working in the repo

- `npm run typecheck` — type-check all packages.
- `npm test` — run unit tests (`node --test`).
- `npm run lint` / `npm run format` — Biome.

## Code conventions

Enforced or expected throughout; see [docs/DESIGN.md](docs/DESIGN.md) §10 for the full list.

- TypeScript `strict`, no `any`; untrusted input validated with `zod` at the boundary.
- ESM, named exports, one responsibility per file, pure logic separated from I/O.
- The bridge protocol and tool schemas live once in `shared/src/protocol.ts`; types are inferred from the zod schemas.
- Conventional Commits.
