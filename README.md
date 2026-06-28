# browsight

> A universal, permissioned **read-and-act** tool that exposes your real, authenticated Chrome to any MCP client — at a few hundred tokens per page.

`MIT` · `TypeScript (strict)` · `Node 24` · `Manifest V3`

browsight lets an AI agent (Claude Code, Antigravity, Cursor, …) read and act on any site you are **already signed into**, using your **real Chrome session**, through two small, deterministic, permissioned tools. One representation works on every page — there is no per-site code.

It is three pieces: a **Manifest V3 Chrome extension** (the only part that touches the page), a **local MCP server** (what the agent talks to), and a **token-authenticated loopback WebSocket** between them.

**Status:** working MVP — read + act + a whitelist permission gate, verified end to end on real logged-in pages.

---

## Why

Most browser tooling for AI agents has three problems browsight fixes:

- **Authentication** — they launch a fresh, signed-out browser. browsight uses your real, logged-in profile.
- **Token cost** — they send screenshots or raw DOM (tens of thousands of tokens). browsight sends a clean *semantic snapshot* (a few hundred tokens).
- **Safety** — they rarely have a real permission boundary. browsight enforces a deterministic, capability-based gate inside the extension.

It complements your agent's built-in web search (it targets the authenticated, interactive web those tools cannot reach) — it does not replace public-web search.

## How it works

```
AI agent (Claude Code / Antigravity)
   │  MCP over stdio
   ▼
browsight server (Node)            ← the two tools; secret-stripping; diffing
   │  loopback WebSocket on 127.0.0.1 + per-install token
   ▼
browsight extension (Manifest V3)  ← runs in YOUR Chrome; the only thing that touches the page
   │  builds the semantic snapshot; enforces the permission gate
   ▼
the live, logged-in page
```

Since Chrome 136 disabled remote-debugging on the default profile, an in-browser extension is the only way to reach authenticated tabs — that is why browsight is an extension, not CDP.

## The two tools

```
browser_read  { url? }                  → the current tab as clean markdown + numbered references
browser_act   { ref, action, value? }   → one action (click/fill/navigate/scroll) + verdict + diff
```

A read looks like this:

```
# Inbox — 3 unread
Receipt from Stripe arrived today.
[button "Compose" #5]
[textbox "Search mail" #6]
- [link "Stripe receipt" #7]
```

The agent reads that, then acts by reference — `click #5`, `fill #6 with …`.

## Features

- **Universal semantic snapshot** — any page → clean markdown + stable references, built in-page from the accessibility tree (role + accessible name).
- **Token-lean** — a few hundred tokens for a typical page; no screenshots by default.
- **Self-healing references** — re-resolved at act time from a durable recipe (role + name + `data-*` + text); never hashed CSS classes; returns ranked candidates when ambiguous instead of guessing.
- **Typed results** — every action returns a verdict (`navigated` / `dom_changed` / `value_set` / `no_change`) plus a diff of what changed.
- **Capability-based permissions** — deny-by-default whitelist with read-only / full-control tiers and an optional timer, backed by Chrome's own host-permission system; policy lives in the extension, outside the model's reach.
- **One-command setup** — `npm run setup` wires both sides (zero token copy-paste); `npm run doctor` checks the connection.
- **Any MCP client** — Claude Code, Antigravity, Cursor, Windsurf, … (only the one-time registration differs).

## Tech stack

- **TypeScript** (strict) on **Node 24**, ESM, an npm-workspaces monorepo
- **MCP:** `@modelcontextprotocol/sdk` (stdio) · **Transport:** `ws` + a per-install token
- **Extension:** Manifest V3 (service worker + content script + popup/options)
- **Perception:** `dom-accessibility-api` · **Validation:** zod v4 (one shared, typed protocol)
- **Diff:** jsdiff · **Build:** tsdown (server) + esbuild (extension) · **Lint/format:** Biome · **Tests:** `node --test`

## Install & try it

Requires **Node 24 (LTS)**. From the repo root:

```
npm install
npm run build      # compiles the server + the extension
npm run setup      # wires both sides, registers the MCP server, prints the next step
```

Load the extension (one time):

1. Open `chrome://extensions` → enable **Developer mode**
2. Click **Load unpacked** → select `extension/dist`
3. Restart your MCP client

Allow a site: click the **browsight** toolbar icon on a logged-in page → pick a tier → **Grant access**.

## Usage

You do not use the extension directly — you talk to your agent. Ask in plain English:

> "read this page" · "summarize my GitHub notifications" · "click the Sort button" · "fill the search box with bookmarking"

The agent calls `browser_read` / `browser_act` behind the scenes. Run `npm run doctor` to check the connection. Setup for **Google Antigravity** is in [antigravity/](antigravity/README.md).

## Security model

Capability = (site × action), deny-by-default, revocable. The agent **requests**; the extension — the only component that can reach the page — **decides and executes**. Policy is stored in the extension and is neither readable nor editable by the model. Honest framing: this is **blast-radius containment**, not a claim to prevent prompt injection. Details and decision records are in [docs/DESIGN.md](docs/DESIGN.md).

## Project structure

```
browsight/
├─ extension/    Manifest V3 extension (the only component touching the DOM)
├─ server/       MCP server, bridge, post-processing, tests
├─ shared/       protocol.ts — one zod-validated contract
├─ scripts/      setup.ts — one-command bootstrap + doctor
├─ antigravity/  setup guide for Google Antigravity
└─ docs/         DESIGN.md — architecture, conventions, ADRs
```

## Development

```
npm run typecheck
npm test           # node --test (unit + a bridge integration test)
npm run lint       # Biome
npm run build
```

Product spec: [PRD.md](PRD.md). Technical design + decision records: [docs/DESIGN.md](docs/DESIGN.md). Deferred work: [ROADMAP.md](ROADMAP.md).

## Roadmap (high level)

The full permission layer (per-action confirmation, provenance tripwire, audit log), advanced reads (schema extraction, virtualization-aware reads), the DevOps + security CI pass, and npm / store distribution. See [ROADMAP.md](ROADMAP.md).

## Honest caveats

- Token reductions vary by page; application-shaped pages cost more than content pages.
- Synthetic input is `isTrusted:false`; a few hardened controls need more (deferred).
- Closed shadow roots and cross-origin iframes are surfaced as explicit sentinels, not silently read.
- This is an **MVP** — read + act + a whitelist gate. The richer controls are on the roadmap.

## License

MIT — see [LICENSE](LICENSE).
