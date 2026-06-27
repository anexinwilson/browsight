# browsight

> A universal, permissioned **read-and-act** tool that exposes your real, authenticated Chrome to any MCP client.

browsight lets an MCP client (Claude Code, Cursor, Antigravity, …) read and act on any site you are already signed into — using your real Chrome session — through a small, deterministic, permissioned tool surface. There is no per-site logic: one representation works on every page.

**Status:** early development. The product spec is in [PRD.md](PRD.md), the technical design and decision records are in [docs/DESIGN.md](docs/DESIGN.md), and deferred work is in [ROADMAP.md](ROADMAP.md).

## The tools

- `browser_read` — clean, structured context of the current tab.
- `browser_act` — one bounded action (`click` / `fill` / `navigate` / `scroll`) by reference.

## How it works

```
MCP client ──stdio──▶ browsight server (Node) ──ws + token──▶ extension ──▶ the page
```

A Manifest V3 extension runs in your real Chrome (the only component that touches the page); a local MCP server talks to it over a token-authenticated loopback WebSocket. See [docs/DESIGN.md](docs/DESIGN.md).

## Development

Requires Node 24 (LTS) — see `.nvmrc`.

```
npm install
npm run typecheck
npm test
npm run build
```

Setup and load-unpacked steps are in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).
