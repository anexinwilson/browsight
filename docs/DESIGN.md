# browsight — Technical Design

> How browsight is built. Companion to the product spec in [PRD.md](../PRD.md), which covers what and why. This document covers the architecture, data formats, key algorithms, the concrete build decisions, and the decision records.

---

## 1. Component model and data flow

browsight is a three-package npm-workspaces monorepo. Each package runs in a distinct runtime:

| Package | Runtime | Responsibility |
|---|---|---|
| `server/` | Node 24 (LTS) | The MCP server (stdio), the bridge (`ws` server), and post-processing (diff, secret stripping, validation). |
| `extension/` | Chrome (MV3) | The service worker (bridge client) and the content script (the only code that touches the page). |
| `shared/` | both | `protocol.ts` — one zod-validated, transport-agnostic message contract imported by both sides. |

**End-to-end flow of a `browser_read`:**

1. The MCP client calls `browser_read` over stdio.
2. The server validates the input, then sends a `ReadRequest` frame over the loopback WebSocket to the extension.
3. The service worker forwards it to the content script of the active tab via `chrome.tabs.sendMessage`.
4. The content script builds the semantic snapshot in-page and returns `{ markdown, refs, meta }`.
5. The service worker relays it back over the WebSocket; the server strips secrets, estimates tokens, and returns the MCP result.

`browser_act` follows the same path, with the content script resolving the reference, performing the action, waiting for settle, and returning a typed verdict + diff.

---

## 2. The bridge protocol (`shared/protocol.ts`)

All cross-process messages are zod schemas, validated on receipt at every boundary. One discriminated union, keyed by `type`:

- `auth` — first frame from the extension: `{ type: "auth", token: string, extensionVersion: string }`. The server constant-time-compares the token before processing any other frame; a failed or late (> 2 s) auth drops the socket.
- `read.request` / `read.response` — `{ url?, schema? }` → `{ markdown, refs: Ref[], tokenEstimate, sentinel? }`.
- `act.request` / `act.response` — `{ ref, action, value? }` → `{ verdict, diff, refs, sentinel? }`.
- `error` — a typed sentinel envelope (see §4) carried as a successful response with `isError: true`, never a thrown exception, so it reaches the model's reasoning loop.

Framing is JSON over the WebSocket. `maxPayload` on the `ws` server is set high enough for full-page snapshots; each frame is size-checked and zod-parsed before use.

**Example — a read then an act:**

```jsonc
// 1. client calls browser_read → server sends over the bridge:
{ "type": "read.request", "url": null, "schema": null }

// 2. extension replies with the snapshot:
{
  "type": "read.response",
  "tokenEstimate": 740,
  "markdown": "# Inbox — 3 unread\n[button \"Compose\" #5]\n[textbox \"Search mail\" #6]",
  "refs": [
    { "id": 5, "role": "button",  "name": "Compose",
      "recipe": { "role": "button", "name": "Compose", "text": "Compose", "ordinal": 0 } },
    { "id": 6, "role": "textbox", "name": "Search mail",
      "recipe": { "role": "textbox", "name": "Search mail", "dataAttrs": {}, "ordinal": 0 } }
  ]
}

// 3. client calls browser_act → and the typed reply:
{ "type": "act.request", "ref": "5", "action": "click" }
{
  "type": "act.response",
  "verdict": "dom_changed",
  "diff": { "appeared": ["#9 button \"Send\""], "removed": [], "changed": [] },
  "refs": [ /* refreshed for the new snapshot */ ]
}
```

---

## 3. Perception — the semantic snapshot

Built entirely in the content script against the live DOM. No content-script API exposes Chrome's computed accessibility tree, so browsight reconstructs the semantics.

**The walk.** Traverse the DOM (descending open shadow roots and same-origin iframes), keeping nodes that are interactive or meaningful: `button`, `a[href]`, form controls, `[role]`, `[tabindex]`, `contenteditable`, elements with click handlers, plus headings, list items, and text blocks for readable content.

**Per node.** Resolve role with `getRole(el)` and accessible name with `computeAccessibleName(el)` (both from `dom-accessibility-api`). Attach DOM-only facts the a11y layer lacks: bounding box, in-viewport flag, visibility, and the nearest stable-attribute ancestor.

**Output format.** Clean, markdown-style readable text with interactive elements inlined and tagged:

```
# Inbox — 3 unread
Receipt from Stripe arrived today.
[button "Compose" #5]
[textbox "Search mail" #6]
- [link "Stripe receipt" #7]
```

For long-form content pages, `@mozilla/readability` (gated by `isProbablyReaderable`, run on `document.cloneNode(true)`, emitting `textContent` only) supplies the prose, converted with `turndown`. App-shaped pages fall back to the visible-text walk.

**References.** `#N` is an **ephemeral index** valid only within one snapshot. Each ref also carries a durable **recipe** — `{ role, accessibleName, dataAttrs, text, ordinalAmongSiblings, ancestorPath }` — stored so the act path can re-resolve it on a possibly re-rendered page. The recipe never anchors on hashed class names.

**Coverage edges.** Closed shadow roots and cross-origin iframes are unreachable; the walk emits an explicit `frame_unreachable` sentinel for them rather than dropping content silently.

---

## 4. Acting and the typed result

**Resolution.** At act time the content script re-resolves the ref from its recipe against the live DOM and scores candidates by weighted attribute overlap (role + name first, then `data-*`/text, position last). One confident match → act. A tie or no clear winner → return ranked `ambiguous_target` candidates rather than guessing. A target that has drifted → `ref_stale`.

**Primitives.** `click`, `fill`, `navigate`, `scroll`. `fill` uses the native value setter, resets React's `_valueTracker`, and dispatches `input`/`change` (so controlled inputs register). All synthetic events are `isTrusted:false`; the rare handlers that require trusted input fall in the dangerous class.

**Settle.** Before reading the result, a hand-rolled detector waits on a MutationObserver quiet-window, `document.readyState`, and an in-flight `fetch`/XHR counter, with a hard timeout. Durations are injectable for deterministic tests.

**Verdict + diff.** Every action returns one of `navigated | dom_changed | value_set | no_change` plus the delta: a `jsdiff` line diff over the before/after markdown, and a ref-keyed set diff over the interactive elements (appeared / disappeared / state-changed). `no_change` is gated behind the settle window so a slow async update is not reported as a false negative.

**Sentinels.** A closed enum of typed dead-ends — `not_signed_in`, `ambiguous_target`, `ref_stale`, `not_actionable`, `frame_unreachable`, `not_whitelisted` — each with a one-line recovery hint, returned with `isError: true`.

---

## 5. The extension (MV3)

**`manifest.json`** — `manifest_version: 3`; permissions `activeTab`, `scripting`, `storage`; `optional_host_permissions` for granted sites; an `action` (popup) and an options page; a `background.service_worker`.

**Service worker** — opens the WebSocket to `127.0.0.1:<port>`, sends the `auth` frame, and reconnects on wake (MV3 workers are evicted when idle; active WS traffic plus a ~20 s keepalive ping holds it, and state rehydrates from `chrome.storage.session`). Routes `read`/`act` frames to the active tab's content script.

**Content script** — declared for `all_frames`; builds the snapshot and performs actions. A MAIN-world injection (`chrome.scripting.executeScript({ world: "MAIN" })`) exposing a **fixed verb set** is reserved for later phases (page-JS reads); it is not in the MVP.

**Permission UI** — a popup (current-site grant) and an options page (all sites), writing policy to `chrome.storage`. Grants map to Chrome host permissions via `chrome.permissions.request`. Optional expiry timers are scheduled with `chrome.alarms` (survives worker eviction).

---

## 6. The MCP server (Node)

`McpServer` + `StdioServerTransport` from `@modelcontextprotocol/sdk` (v1.x), registering `browser_read` and `browser_act` with zod input schemas. A `ws` server binds `127.0.0.1` on a fixed default port (configurable) with automatic fallback to the next free port. Post-processing — secret stripping (`<input type=password>` values plus token-shaped strings), token estimation, and diff assembly — runs here, off the content-script hot path.

---

## 7. Connection bootstrap and token sharing (zero copy-paste)

`scripts/setup.ts` generates a high-entropy token and resolves a free port, then writes the pair to **two places**: `~/.browsight/bridge.json` (read by the server) and a `connection.json` inside the unpacked extension folder (read by the extension on load). Because both sides obtain the same token/port from disk at setup time, there is no manual paste — the extension authenticates automatically on first connect. `setup` also writes the MCP server entry into the detected client config, copies the extension path to the clipboard, and opens `chrome://extensions`. `browsight doctor` walks client-config → server → WS bind → token handshake → extension reachability and names the first broken link.

---

## 8. Permission enforcement (MVP)

Policy lives in `chrome.storage` (outside the model's reach). Each whitelisted origin has a tier (`read` | `full`) and an optional expiry. Every `act` request passes a deterministic gate in the extension that checks `(origin, action-class, tier, not-expired)` before executing; a miss raises the ask-on-miss prompt (allow once / allow always / deny) or refuses with `not_whitelisted`. The Phase 3 additions (dangerous-class confirmation, per-action permissions, provenance tripwire, audit log) layer onto this same gate.

---

## 9. Testing

Pure logic — snapshot builder, role/name resolution, reference matcher, secret stripping, diff — is unit-tested against saved real-page HTML fixtures with `node --test`, including an assertion that password values never appear in output and a reference-scoring test that ranks two same-name buttons correctly across a re-render. A small set of end-to-end smoke tests loads the unpacked extension into a headless Chrome and exercises a real read → act → diff through the bridge.

---

## 10. TypeScript and code conventions

**Compiler.** A single `tsconfig.base.json` at the root sets the strict baseline; each package extends it. Beyond `strict: true` it enables `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, and `verbatimModuleSyntax`. `noEmit` is set — `tsdown` builds, `tsc` only type-checks — and project references give the monorepo incremental builds and enforced package boundaries.

**Types as one source of truth.** The bridge protocol and the MCP tool schemas are defined as `zod` schemas in `shared/protocol.ts`; the TypeScript types are `z.infer`-ed from them, so runtime validation and static types cannot drift. Messages are a discriminated union keyed by `type`, so the compiler forces every handler to cover every case.

**No `any`, no magic strings.** Untrusted input is typed `unknown` and narrowed by a zod parse at the boundary. Action names and sentinel keys are `const`-typed unions, not loose strings, so a typo is a compile error. `readonly` guards data that must not mutate; `import type` marks type-only imports.

**Errors as values.** Expected failures are the typed sentinels (returned, not thrown); exceptions are reserved for genuine bugs.

**Module hygiene.** ESM throughout (`"type": "module"`), named exports (no default exports), one responsibility per file, pure functions separated from I/O, and JSDoc on every exported function. Biome and `.editorconfig` keep formatting identical across editors.

---

## 11. Architecture decision records

**ADR-1 — Extension, not external CDP.** Chrome 136 disables `--remote-debugging-port` on the default profile, so external CDP reaches only a fresh, logged-out profile. An in-browser MV3 extension is the only way to operate on the user's authenticated tabs. *Consequence:* manual load-unpacked install; page access limited to what content scripts and (later) MAIN-world injection provide.

**ADR-2 — Loopback WebSocket bridge, committed.** Chosen over Native Messaging for the MVP and beyond: simpler to build, no per-message size cap (snapshots can be large), and no per-OS host-manifest registration. Secured by `127.0.0.1` binding, a first-frame token, and Chrome's Local Network Access prompt. *Consequence:* an open loopback port reachable by same-user local processes — an accepted floor; the transport-agnostic `protocol.ts` keeps Native Messaging available as a future swap.

**ADR-3 — In-page accessibility reconstruction.** No content-script API exposes Chrome's computed a11y tree, so role/name are reconstructed in-page with `dom-accessibility-api`. *Consequence:* shadow-encapsulated names can be wrong and are surfaced as sentinels, not silently mislabeled.

**ADR-4 — Library choices.** `dom-accessibility-api` supplies both role (`getRole`) and name, so `aria-query` is unnecessary. `tsdown` replaces the now-unmaintained tsup. The reference scorer, settle detector, framework-safe fill, and structured diff are hand-rolled (no fit-for-purpose library); `jsdiff` covers the text delta. `jsdom`, `axe-core`, `@postlight/parser`, `html-to-text`, `@testing-library/dom`, and Playwright/Puppeteer are deliberately excluded (wrong runtime or wrong shape).

**ADR-5 — Rejected connection alternatives.** Chrome 144's permission-gated external CDP bypasses the extension (no capability gate; raw CDP is arbitrary code) and is version-thin — rejected as a transport, cited as evidence the extension is the right trust boundary. Pure `chrome.debugger` as a baseline imposes a permanent "is being debugged" banner — rejected; kept only as an optional, opt-in escalation for trusted input in a later phase. WebDriver BiDi launches a logged-out browser with no extension entry point — rejected.

---

## 12. Open questions

These are deliberately left to the first build iteration, where code is the right place to settle them:

- **Snapshot serialization rules** — which non-interactive nodes to include, how deeply to nest, and how to render lists/tables versus prose. The §3 example fixes the shape; the precise rules are tuned against real fixtures.
- **Reference-scoring weights** — the relative weight of role/name versus `data-*`, text, and ordinal in the self-healing matcher, and the confidence threshold for auto-acting versus returning candidates. Tuned against fixtures with a known-correct ranking.
- **Default bridge port** — a fixed default with automatic fallback; the specific number is cosmetic.
- **Client auto-detection scope** — the MVP targets one client's config; which others `setup` detects is added incrementally.
- **Secret-stripping patterns** — the initial set (`<input type=password>`, common key/token shapes) expands as real pages surface new cases, guarded by a regression test so it only grows.

---

## 13. Glossary

- **Semantic snapshot** — the in-page, text-based view of a page: clean readable content plus every interactive element tagged with a reference. The single representation used for both reading and acting.
- **Reference (`#N`)** — an ephemeral index into one snapshot that the agent uses to name an element to act on; re-resolved against the live DOM at act time.
- **Recipe** — the durable, multi-attribute fingerprint stored per reference (role, accessible name, `data-*`, text, ordinal, ancestor path) used to re-resolve it on a changed page without anchoring on hashed class names.
- **Sentinel** — a typed, named dead-end result (e.g. `not_signed_in`, `ambiguous_target`) carrying a recovery hint, returned to the agent instead of a silent empty or a thrown error.
- **Gate** — the deterministic permission check in the extension that every action passes through before executing.
- **Tier** — a whitelisted site's access level: read-only or full-control.

---

*browsight technical design — build order follows the PRD phases: read path, then act, then the full permission layer.*
