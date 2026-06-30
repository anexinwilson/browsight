<p align="center">
  <img src="https://raw.githubusercontent.com/anexinwilson/browsight/main/docs/logo.png" alt="browsight logo" width="128">
</p>

<h1 align="center">browsight</h1>

<p align="center">
  Give your AI agent eyes inside your real, logged-in Chrome.
</p>

<p align="center">
  <code>MIT</code> · <code>TypeScript</code> · <code>Node 24</code> · <code>Manifest V3</code>
</p>

---

Most browser automation tools spin up a headless browser with no cookies, no saved logins, no history. browsight is different — it connects your AI agent directly to the Chrome tab you already have open.

It works as a Chrome extension paired with a tiny local server. The extension reads the page, the server talks to your MCP client (Claude, Cursor, Codex, etc.), and the agent can click buttons, fill forms, navigate pages, and switch tabs — all inside your actual session.

No new browser window. No logging in again. No screenshots.

---

## Quick start

Requires **Node 24+**.

```bash
npx -y browsight setup
```

That one command does everything: generates a secure token, copies the extension to your machine, and registers the MCP server with your AI client automatically.

**Then load the extension into Chrome (one time):**

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select `~/.browsight/extension`

Restart your MCP client (Claude Desktop, Cursor, etc.) and you are done.

**Allow a site:** click the browsight icon in your toolbar, pick **read-only** or **full control**, and click **Grant access**. Do this once per site — the agent remembers it.

**Check everything is working:**

```bash
npx browsight doctor
```

---

## What the agent can do

```
browser_read   { url? }                → current page as compact markdown + numbered element refs
browser_act    { ref, action, value? } → click / fill / navigate / scroll
browser_tabs   { select? }             → list open tabs, or switch to one and read it
```

A typical Gmail inbox comes out to about 300 tokens. A LinkedIn job listing is around 400. The agent can read, act, and navigate without you manually copying anything.

---

## How it reads a page

The extension runs a content script that walks the live DOM using the browser's own accessibility tree — the same signal a screen reader uses. Every element gets its ARIA role and accessible name. Hidden elements, scripts, styles, and footers are skipped.

A Gmail inbox looks like this to the agent:

```
# Inbox — 3 unread
Receipt from Stripe arrived today.
[button "Compose" #5]
[textbox "Search mail" #6]
- [link "Stripe receipt" #7]
```

When the agent acts on `#5`, the extension looks it up by role + accessible name — not a brittle CSS selector. References survive re-renders. Every action returns a diff of what changed so the agent knows what happened without reading the page again.

---

## Architecture

```
AI agent (Claude, Cursor, Codex…)
   │  MCP over stdio
   ▼
browsight server  (Node.js, local)
   │  WebSocket · 127.0.0.1 only · per-install auth token
   ▼
browsight extension  (Manifest V3 · service worker + content script)
   │  permission-gated · runs inside YOUR Chrome
   ▼
your real browser tab
```

The extension is the only part that ever touches a page. The server routes messages and strips secrets (passwords, API keys) from snapshots before they reach the model. The WebSocket only binds to loopback — nothing is exposed on your network.

---

## Permissions

Sites are **denied by default**. You grant access per-site through the extension popup. The whitelist lives in `chrome.storage.local` and can only be written by you through the popup UI after a Chrome-native permission prompt.

No MCP message can grant or escalate access. The agent cannot read or modify the whitelist. Non-whitelisted tabs appear in `browser_tabs` by origin only, so the agent can ask you to allow them — it never silently fails or reads something you did not approve.

---

## Why not CDP or Playwright?

Chrome 136 disabled remote debugging on the default profile. Playwright and CDP now require launching a separate browser process — which means no cookies, no saved logins, no extensions. An in-browser Manifest V3 extension is currently the only reliable way to reach your real, authenticated tabs without any of that.

---

## Caveats

- **Cross-origin iframes** cannot be read — they appear as `[unreadable frame (cross-origin)]` so the gap is always visible to the agent
- **Same-origin iframes** and open shadow roots are fully traversed
- **Synthetic events** have `isTrusted: false` — a small number of hardened inputs detect this
- Token count varies — content-heavy pages compress significantly more than dense app UIs

---

## Contributing

```bash
git clone https://github.com/anexinwilson/browsight
cd browsight
npm install
npm run build       # tsdown (server) + esbuild (extension)
npm test            # 112 unit tests
npm run lint        # Biome
```

After editing the extension, run `npm run build` and click the **reload icon** on the extension card in `chrome://extensions`.

CI runs on every push: typecheck, lint, tests, SonarCloud static analysis, and Snyk dependency scan.

---

## Stack

- **TypeScript** strict · Node 24 · ESM · npm workspaces
- **Perception:** `dom-accessibility-api` for ARIA role + accessible name resolution
- **Protocol:** zod v4 schema shared between extension and server
- **Transport:** `ws` WebSocket · loopback only · per-install token auth
- **MCP:** `@modelcontextprotocol/sdk` (stdio)
- **Build:** tsdown (server) · esbuild (extension)
- **Quality:** Biome · `node:test` · SonarCloud · Snyk

---

## License

MIT
