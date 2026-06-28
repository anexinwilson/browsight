# browsight — Product Requirements Document

> A universal, permissioned **read-and-act** tool that exposes your real, authenticated Chrome to any MCP client.

**Status:** Draft &nbsp;·&nbsp; **Version target:** v1 (read) → v1.x (act, permission layer) &nbsp;·&nbsp; **License:** MIT

---

## 1. Summary

browsight exposes a user's existing, authenticated Chrome session to an MCP client as a small, universal toolset: read the current page as clean, structured context, and act on it. It works on **any** site the user is signed into — there is no per-site logic. It runs as a user-loaded Manifest V3 extension in the user's own Chrome profile, communicates with a local MCP server over a token-authenticated loopback WebSocket, and enforces a deterministic, capability-based permission model inside the extension. As a standard MCP server it works with any MCP-compatible client.

---

## 2. Problem statement

Browser tooling for LLM agents has three recurring gaps:

1. **Authentication.** Most tools launch a fresh, isolated browser instance with no signed-in sessions, placing authenticated workflows out of reach.
2. **Token efficiency.** Screenshot- and raw-DOM-based approaches send large payloads — often tens of thousands of tokens per page — much of which is navigation and boilerplate.
3. **Safety.** Few provide a deterministic, local permission boundary. Where permissions exist they are typically coarse (site-level only) and enforced inside the model's trust boundary, where injected page content can override them.

browsight addresses all three with one universal mechanism: the user's own authenticated profile, content reduced to clean structured context, behind a deny-by-default capability gate.

**Positioning.** browsight complements a client's general web browsing; it does not replace it. Open, unauthenticated content is already well served by built-in web search and fetch. browsight targets the part those tools cannot reach: the authenticated, interactive, and bot-restricted web.

**Platform constraint.** Since Chrome 136, the remote-debugging interface is disabled on the default (logged-in) profile, so authenticated tabs can only be reached from inside the browser. browsight therefore runs as an extension. (Chrome 144 later added a consent-gated path back in for external tools, which only reinforces that the in-extension path is the right trust boundary.)

---

## 3. Goals and non-goals

**Goals (v1)**
- One universal representation that lets an agent read and act on **any** authenticated page — no per-site handling.
- Operate in the user's real Chrome profile (and incognito when enabled) with no re-authentication.
- Keep the tool surface minimal and predictable.
- Act reliably by element reference rather than pixel coordinates.
- Establish a deterministic, local, user-defined permission boundary the agent cannot bypass.

**Non-goals (v1)**
- Replacing general web search for public content.
- Per-site scrapers or site-specific integrations.
- Multi-browser support (Chrome only).
- Reading chart/canvas pixels.
- General-purpose automation parity with Playwright.

---

## 4. Client compatibility

browsight is a standard MCP server over the stdio transport, so any MCP-compatible client can use it — Claude Code, Cursor, Windsurf, VS Code, Antigravity, etc. The server and extension are identical across clients; only the one-time registration step differs.

---

## 5. Primary user and representative tasks

**Primary user:** a single technical user operating on their own machine, with their own browser sessions.

**Representative tasks (any logged-in site):**
- Summarize the user's current notifications on an authenticated site.
- Read and act on a project management board.
- Pull figures from a logged-in dashboard.
- Fill and submit a form on a site the user is signed into.
- Read content behind a login the user holds.

**Profiles:** the real profile (default; uses existing logins) and incognito (when the user enables "allow in incognito"; a fresh, anonymous session).

---

## 6. Architecture

```
MCP client (Claude Code, …)
   │  MCP over stdio
   ▼
browsight MCP server (Node)         ← hosts a ws server on 127.0.0.1
   ▲  loopback WebSocket + per-install token   (committed transport)
   │     the extension dials out; the server listens
browsight extension — service worker (in the user's real Chrome)
   │  Chrome runtime messaging
   ▼
content script (active tab)         ← builds the semantic snapshot, drives the page
   ▼
the live page DOM
```

**Responsibilities**
- **MCP server** — the protocol surface; post-processing (diff, validation, secret stripping).
- **Extension** — the only component with DOM access; the policy enforcement point.
- **Bridge** — token-authenticated loopback WebSocket; no publicly reachable port.

**Transport decision (committed):** the loopback WebSocket is the bridge for all phases — simplest to build, no per-message size cap, and well-secured by binding `127.0.0.1`, authenticating with a high-entropy per-install token in the first frame (constant-time compared), and relying on Chrome's Local Network Access prompt that gates web pages from reaching loopback. The protocol contract in `shared/protocol.ts` is transport-agnostic, so the bridge could be replaced without touching any other logic, but no migration is planned.

---

## 7. How it works — the universal read/act model

The single representation is a **semantic snapshot**, built in-page by the content script. No content-script API exposes Chrome's computed accessibility tree, so browsight **reconstructs** the semantics from the live DOM: it walks interactive and meaningful nodes and, for each, resolves an ARIA role and accessible name, emitting clean readable text plus interactive elements tagged with a stable reference.

```
# Inbox — 3 unread
Receipt from Stripe arrived today.
[button "Compose" #5]
[textbox "Search mail" #6]
- [link "Stripe receipt" #7]
```

The same artifact serves understanding and acting, on any page type — so there is no per-site code. The operating loop:

1. **Read** — the agent receives the combined readable-plus-actionable view.
2. **Act** — the agent acts by reference (`click #5`, `fill #6`), never by pixel.
3. **Diff** — only what changed is returned, with a typed verdict (below).
4. Repeat.

---

## 8. Interface

```
browser_read  { url?: string, schema?: object }   → clean structured context of the active tab;
                                                     with a schema, returns validated JSON to that shape
browser_act   { ref: string, action: "click" | "fill" | "navigate" | "scroll", value?: string }
                                                     → one bounded action, then a typed verdict + diff
```

**Constraints**
- No arbitrary-code-execution tool. Capabilities absent from the tool surface cannot be requested by any prompt.
- No screenshot by default.
- References are re-resolved against the live DOM at act time, never stored as node pointers.

---

## 9. Efficiency and agent-experience design

These make the consuming agent efficient and hard to get stuck — on any site:

- **Clean extraction, not raw DOM** — strip navigation, ads, and boilerplate to signal.
- **Structured extraction** — an optional schema returns typed records (server-side projection: the agent declares the fields and never sees the rest); a missing field is an explicit validation error, never a fabricated value.
- **Self-healing references** — a reference is a multi-attribute recipe (role + accessible name + `data-*` + text), re-resolved and scored fresh at act time; it never anchors on hashed class names, and ambiguous matches return ranked candidates rather than guessing.
- **Typed effect-verdict + diff** — every action returns one of `navigated | dom_changed | value_set | no_change` plus only the delta, so the agent never re-reads just to check whether its action landed. A short settle window guards against a slow async change reading as a false `no_change`.
- **Teaching sentinels** — every dead end is a named result (`not_signed_in`, `ambiguous_target`, `ref_stale`, `not_actionable`, `frame_unreachable`) with a one-line recovery hint, returned so it enters the agent's reasoning — never a silent empty or a stack trace.
- **Accessibility-tree-reconstructed grounding** — one representation that works on any page.

Token reductions are real but vary by page type and are not claimed to be uniform.

---

## 10. Technical stack

| Concern | Choice | Runtime |
|---|---|---|
| Language | TypeScript, `strict` | — |
| Runtime | Node 24 (LTS) | — |
| Monorepo | npm workspaces | — |
| Build | **tsdown** (Rolldown) | node |
| MCP | `@modelcontextprotocol/sdk` (pin v1.x) | node |
| Bridge | `ws` (extension uses native WebSocket) | node |
| Validation | `zod` (v4) | either |
| Role + accessible name | `dom-accessibility-api` (`getRole` + `computeAccessibleName`) | browser |
| Content extraction | `@mozilla/readability` (gated, in-page) | browser |
| Content → markdown | `turndown` (built `platform:'browser'`) | browser |
| Lint / format | Biome | — |
| Tests | `node --test` | — |

**Hand-rolled (no suitable library):** the snapshot walker, the self-healing reference scorer, the page-settled detector (MutationObserver quiet-window + hard timeout today; `readyState` + an in-flight request counter are planned), the framework-safe fill (native value setter + `_valueTracker` reset + input/change events), and the structured (ref-keyed set) diff.

**Deliberately avoided:** `jsdom` (Node-only; perceive in-page), `aria-query` (`dom-accessibility-api` resolves roles too), `axe-core` (audit engine, wrong shape, MPL-2.0), `@postlight/parser` / `html-to-text` (Node-only / redundant), `@testing-library/dom` (throws on ambiguity), Playwright/Puppeteer (cannot run in an extension).

The MVP runtime footprint is six packages: `@modelcontextprotocol/sdk`, `ws`, `zod`, `dom-accessibility-api`, `@mozilla/readability`, `turndown`.

---

## 11. Security model

browsight is built so the agent operates strictly inside a user-defined boundary and cannot widen its own access. The model issues requests; the extension — the only component that can reach the page — decides and executes. A prompt is treated as a request, never as a control.

**Capability = (site × action), deny-by-default, time-limited, revocable.**

- **User-defined allowlist, pre-registered.** Before a task, the user grants the specific sites and actions browsight may use. Everything else is denied by default.
- **Two tiers.** A broad read-only tier, and a full-control tier limited to explicitly allowlisted sites.
- **No deviation.** browsight executes only actions matching a current grant; anything outside it is refused by the extension, not delegated to the model.
- **Ask-on-miss.** An ungranted action stops and requests explicit user approval.
- **Out-of-band confirmation** for the dangerous class (submit, pay, delete, send, upload, OAuth).
- **Provenance tripwire.** A `fill` value or `navigate` URL derived from prior page-read content is escalated to confirmation — a verbatim tripwire, not a guarantee.
- **Deterministic enforcement.** The gate is code in the extension, outside the model's reach; neither the model nor injected page content can read, edit, or widen the policy.
- **Optional time-to-live** on a grant (default: persistent until manually removed), **immediate manual revocation** at any time, and an **audit log** of every request, its provenance, and the decision.

**Where permissions are managed.** Policy is managed in the extension's own interface — a popup opened from the browsight toolbar icon (for the current site) and a full options page (listing every granted site) — and is stored in `chrome.storage`, which places it outside the model's reach. A user grants a site to a tier (read-only or full-control), and each grant is backed by Chrome's native host-permission prompt (`chrome.permissions.request` over `optional_host_permissions`), so the allowlist is enforced at the browser level, deny-by-default by construction.

**Grants are persistent by default and editable at any time.** A grant survives browser restarts and remains in effect until the user changes or removes it, so a site is configured once rather than re-approved each session. A grant may optionally carry a time-to-live — 1 hour, 2 hours, 4 hours, 12 hours, 1 day, or *never* (the default) — after which it auto-expires. In every case the user can **manually revoke** a grant at any moment from the popup list or the options page, with immediate effect.

**Ask-on-miss is the primary flow.** When the agent requires an ungranted site or action, browsight raises an in-the-moment prompt (allow once, allow always, or deny) rather than failing silently or proceeding, so most users never pre-configure anything — they approve each site once, when it first arises.

To avoid permission fatigue, grants are per-site-and-tier rather than per-action: routine actions on a granted site run without prompting, while the dangerous class always requires an out-of-band confirmation regardless of grant. Every action is checked against the stored policy before it executes; nothing outside the allowlist runs.

**MVP scope.** The read-and-act MVP ships a user-managed **site whitelist with two tiers** (each whitelisted site is read-only or full-control), the **optional timer** (1 hour through *never*), and the **ask-on-miss prompt** (allow once / allow always / deny). Together these gate every read and act: only whitelisted sites are touched, everything else is denied by default. The remaining controls described above — out-of-band confirmation for the dangerous class, per-action permissions, the provenance tripwire, and the audit log — arrive as the Phase 3 full permission layer.

This is capability-based access control applied locally in the browser — blast-radius containment, not a claim to prevent prompt injection.

---

## 12. Repository structure

```
browsight/
├─ extension/    Manifest V3 extension — the only component touching the DOM
├─ server/       MCP server, bridge, post-processing, tests
├─ shared/       protocol.ts — one zod-validated, transport-agnostic contract
├─ scripts/      setup.ts — registers the server, prints token and load-unpacked steps
├─ docs/         DESIGN.md, THREAT-MODEL.md
├─ scratch/      throwaway / experiments — gitignored, never committed
└─ README.md, LICENSE, CONTRIBUTING.md
```

---

## 13. Setup and developer experience

The goal is "working in about a minute" with one guided manual step. `browsight setup` does everything automatable:

1. Unpacks the bundled extension to a fixed folder.
2. Writes the MCP server entry into the detected client's config (no JSON editing).
3. Generates and shares the per-install token (no copy-paste).
4. Copies the extension folder path to the clipboard and opens `chrome://extensions`.

The user then performs the one step Chrome reserves for manual action: Developer mode → Load unpacked → paste → Enter (~15 seconds). The extension auto-connects and a toolbar badge turns green.

**Self-correcting:** a `browsight doctor` command walks the chain and names the first broken link with a fix; failures return named, actionable messages, not stack traces.

**Honest floor:** Chrome does not allow any tool to load an unpacked extension programmatically, so that one click cannot be removed; everything around it is automated. (One-click store distribution is a possible later option.)

---

## 14. Testing approach

- **Unit / fixture tests (the bulk).** Saved real-page HTML fixtures drive the pure logic — the snapshot builder, accessible-name/role resolution, the reference matcher, secret stripping, the diff — with output asserted (correct content, correct references, low token count, and a test proving secrets never appear). Fast, deterministic, run on every commit with `node --test`.
- **End-to-end smoke tests (a small set).** The extension is loaded into a headless Chrome to exercise the full read/act path through the bridge.

Coverage targets the logic that matters, not maximization.

---

## 15. Engineering practices (present from the first commit)

The discipline that lives *in the code* is part of the MVP: TypeScript `strict` with no `any`; `zod` validation at every boundary; ESM; pure logic separated from I/O; current, non-deprecated library and platform APIs; Biome lint/format; Conventional Commits; the monorepo layout; and `LICENSE` / `.gitignore` / `.nvmrc`. The CI and automation that run *around* the code (GitHub Actions, security scanning, release tooling) are deferred to a later iteration.

---

## 16. MVP scope and delivery phases

**MVP (v1) is a working, universal read-and-act tool — not a skeleton.** It delivers both reading (Phase 1) and acting (Phase 2) on any authenticated site, built on the core concepts (the semantic snapshot, the typed shared protocol, the token-gated bridge, pure extraction split from I/O) and the in-code practices above. The full permission layer (Phase 3) extends that base.

### Phase 1 — Read (MVP)
- Extension loads unpacked and completes the token handshake.
- `browser_read` returns clean structured context for any authenticated page using the user's session.
- Reported token estimate is materially below the raw DOM size.
- A login-walled or unauthenticated page returns a clear `not_signed_in` sentinel, not partial content.
- Password fields and obvious secrets are excluded from output.

### Phase 2 — Act (MVP)
- `click`, `fill`, `navigate`, `scroll` succeed on a standard authenticated site, acting by reference.
- Ambiguous targets return ranked candidates rather than guessing.
- Each action returns a typed effect-verdict + diff.
- A site whitelist with two tiers gates everything: each whitelisted site is read-only (read only) or full-control (read and act), carries an optional expiry timer (1 hour through never), and persists until it expires or the user removes it; sites not on the list are never touched.
- Ask-on-miss: an ungranted site prompts the user (allow once / allow always / deny) rather than failing silently or proceeding.
- No arbitrary-JavaScript tool exists.

### Phase 3 — Full permission layer
- Permitted sites and actions are pre-registered; nothing outside the allowlist runs.
- An ungranted action is refused deterministically, regardless of page content.
- The provenance tripwire escalates page-derived fills and navigations to confirmation.
- Policy is stored in extension storage and is neither readable nor editable by the model.
- Every request, its provenance, and the decision are recorded in an audit log.

Work beyond these phases — DevOps, security scanning, distribution, and advanced agent-experience features — is deferred to later iterations.

---

## 17. Risks and limitations

- **Extraction quality varies.** Content pages compress well; application pages remain clean but app-shaped and cost more tokens. Token reductions are not claimed to be uniform.
- **DOM volatility.** Sites with hashed, build-specific class names and frequent UI changes require references to anchor on stable attributes (role, accessible name, `data-*`) and degrade gracefully.
- **Prompt injection cannot be fully prevented.** The permission layer provides blast-radius containment, not prevention.
- **Coverage edges.** Shadow DOM and iframes aren't traversed yet; descent into open shadow roots / same-origin iframes, and a `frame_unreachable` sentinel for what stays unreachable, are planned (see ROADMAP).
- **Synthetic input.** Content-script events are `isTrusted:false`; the common click/fill path works because real framework handlers do not check the flag, and the rare exceptions fall in the dangerous class already routed to confirmation.
- **Service-worker lifecycle.** MV3 workers are evicted when idle, so the bridge reconnects on wake.
- **Not a web-search replacement.** For open, unauthenticated content, a client's native web search is the better tool.

---

## 18. Out of scope (v1)

Per-site integrations; chart/canvas pixel reading; multi-browser support; general automation parity with Playwright; replacing web search for public content. CI, security scanning, distribution, and advanced features are deferred to later iterations.
