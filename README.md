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

## Try it

```
npm install
npm run build
npm run setup        # configures the server + extension connection, prints the next step
```

Then load the extension: open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select `extension/dist`. Restart your MCP client.

In Chrome, open the **browsight** toolbar popup and grant the current site (read-only or full control, with an optional timer). Then, from your MCP client:

- **`browser_read`** — returns the current tab as clean markdown with `#`-numbered references.
- **`browser_act`** — act by reference, e.g. click `#5` or fill `#6` with a value; returns a verdict and a diff of what changed.

Run `npm run doctor` any time to check the connection.

## License

MIT — see [LICENSE](LICENSE).
