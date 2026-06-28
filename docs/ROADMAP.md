# browsight — Roadmap

The MVP is a working, universal read-and-act tool — see [PRD.md](PRD.md) for the product spec and [DESIGN.md](DESIGN.md) for the architecture. This document tracks what comes next, grouped by theme and roughly ordered by priority. It is a living plan delivered through real commits, not a backlog of promises.

## Perception & reliability (near-term)

Hardening the core read-and-act loop, prioritized from real-world testing across GitHub, LinkedIn, YouTube, Reddit, Wikipedia, and Amazon:

- **Shadow DOM & same-origin iframe traversal** — descend open shadow roots and same-origin iframes, with an explicit `frame_unreachable` sentinel for boundaries an extension cannot cross (closed roots, cross-origin frames). Reaches content in modern web-component and embedded-widget UIs.
- **Stronger reference re-resolution** — score self-healing candidates across every recorded attribute (role + name, then `data-*`/text, then position), so an action stays correct on a list of identically-named controls after a re-render.
- **Lazy-content reach** — a viewport-scroll primitive plus a settle signal that waits on `document.readyState` and in-flight requests, so comments, infinite feeds, and deferred content read reliably.
- **Composite controls** — read inside rich editors (`contenteditable`) and option lists, and support `fill` on `<select>` and contenteditable, returning a `not_actionable` sentinel for genuinely unsupported targets.
- **Optional content extraction** — a main-content pass that trims navigation/footer/ad boilerplate on dense pages to cut token cost further.

## Permissions & safety (beyond the MVP gate)

The MVP ships a deny-by-default whitelist with read-only / full-control tiers, an optional timer, and ask-on-miss. Planned extensions:

- **Out-of-band confirmation for high-risk actions** — submit, pay, delete, send, upload, and OAuth always require an in-the-moment confirmation, regardless of standing grant.
- **Provenance tripwire** — a `fill` value or `navigate` URL derived from page-read content is escalated to confirmation, as a guard against prompt-injection-driven actions.
- **Per-action permissions** and an **audit log** recording every request, its provenance, and the gate's decision.
- **Expiry-driven revocation** — release the underlying Chrome host permission via `chrome.alarms` the moment a timed grant lapses.

## Engineering & DevOps

Added incrementally so the repository grows through real commits:

- **CI** (GitHub Actions): type-check, lint, test, and build on every push and PR.
- **Pre-commit hooks** (lint + type-check on staged files) and **Conventional Commits** enforcement.
- **Dependabot** for dependency updates; **branch protection** requiring green CI.
- **Security scanning** — CodeQL (SAST), secret scanning with push protection, and gitleaks in CI; fitting for a tool that operates on an authenticated session.

## Distribution

- **npm** — reduce setup to `npx browsight setup`, bundling the prebuilt extension.
- **Web Store (optional)** — a one-click install for non-technical users, weighed against review and maintenance overhead. The current guided load-unpacked flow is deliberate and remains the default.

## Considered and deferred

Recorded so the design rationale is explicit:

- **`chrome.debugger` / CDP escalation** — the only route to truly trusted input (`isTrusted: true`) and Chrome's authoritative accessibility tree, but it shows a persistent automation banner and needs a broad permission. Deferred as an explicit, per-task opt-in behind a narrow CDP allowlist — never a default.
- **External remote-debugging transports** — reach only a fresh, signed-out profile (and are blocked on the default profile since Chrome 136), so they cannot serve browsight's core goal of using the user's real session. This constraint is exactly why browsight is built as an extension.
- **Native-messaging transport** — a drop-in alternative to the loopback WebSocket if a no-open-port requirement arises; the transport-agnostic protocol keeps it a localized change.

---

*The MVP ships first; everything here follows, one commit at a time.*
