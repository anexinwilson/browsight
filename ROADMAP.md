# browsight — Roadmap (post-MVP)

Everything here is **deferred on purpose**. The MVP is the working universal read-and-act tool defined in [PRD.md](PRD.md); this document captures what is added afterward, through real commits over time. Items are grouped by track, not strictly ordered, but the rough sequence is: finish the read/act/permission feature phases → add the DevOps layer → add security scanning → distribution.

---

## 1. Feature phases (after the read-and-act MVP)

The read and act phases (Phases 1–2) and their build components are defined in [PRD.md](PRD.md). The deferred feature work — universal, with no per-site logic — is below.

**Phase 3 — Full permission layer** (extends the MVP's whitelist + read-only/full-control tiers + optional timer + ask-on-miss)
- **Out-of-band confirmation for the dangerous class** — submit, pay, delete, send, upload, and OAuth always require an in-the-moment user confirmation, regardless of grant.
- **Per-action permissions** — granular control beyond the read-only / full-control tiers.
- **Provenance tripwire** — a `fill` value or `navigate` URL derived from prior page-read content is escalated to confirmation.
- **Audit log** — every request, its data provenance, and the gate's decision are recorded.

**Advanced reads and agent-experience features**
- **Compound act** — an ordered list of safe steps in one call with auto-settle and one consolidated diff (dangerous-class steps still split out for confirmation).
- **Dry-run preview** — a non-mutating resolve that shows exactly what a reference will hit, scoped to the dangerous class so the user never confirms a mistargeted action.
- **Region scoping + steering sentinels** — cap large reads and return a "more available — re-read with a schema or scroll" instruction instead of a truncated dump.
- **Virtualization-aware reads** — detect virtualized lists, tables, and editors (where off-screen rows or lines are not in the DOM) via `aria-rowcount` versus rendered rows or an oversized `scrollHeight`, then scroll-accumulate the full content keyed by `aria-rowindex` or a content hash, budget-capped, restoring the original scroll position. Report the true total with a steering sentinel when capped, and pair with schema extraction so only the requested fields cross the wire. Universal — covers big tables, infinite feeds, and code editors with no per-site logic.
- **Change-status polling** — for "has X changed yet" tasks, watch declared fields and return `same` or just the changed values, so a polling agent stops on a one-token verdict.
- **Action caching** — replay a proven action recipe without re-inference, re-validated against the permission gate on every replay.

---

## 2. DevOps

Added once the read path works (kept out of the MVP so the repo grows through real commits):

- **GitHub Actions CI** — type-check, lint, test, build on every push and PR.
- **Husky + lint-staged** — pre-commit hook running lint + type-check on staged files.
- **commitlint** — enforce Conventional Commits.
- **Dependabot** — automated dependency-update PRs.
- **Branch protection** — require CI green before merge.
- **Changesets** — versioning, changelog, and release automation.

---

## 3. Security hardening

A dedicated pass once CI is in place. (These are CI/process additions; the in-code security model — the capability gate — is part of the MVP, in [PRD.md](PRD.md) §11.)

- **CodeQL** — static analysis (SAST), GitHub-native, results in the Security tab.
- **gitleaks** — secret scanning in CI (thematically core for a secrets-handling tool).
- **GitHub secret scanning + push protection** — native, blocks secrets before they land.
- **OpenSSF Scorecard** — security-posture score with a README badge.
- *Snyk is not needed* — CodeQL + Dependabot cover the same ground, free and native.
- **Native-messaging transport (optional)** — only if a no-open-port requirement ever arises; the transport-agnostic `shared/protocol.ts` makes it a bridge-module-only swap. Carries a per-OS host-registration step and a 1 MB message cap (chunking), so it is not adopted by default.

---

## 4. Distribution

The MVP install is the guided no-store load-unpacked flow in [PRD.md](PRD.md) §13. Later distribution options, in order of effort:

- **Publish to npm** so the install is `npx browsight setup` (test locally with `npm pack` / `npm link` / `npm publish --dry-run` first). The package bundles the prebuilt extension, which the setup command unpacks to a known folder.
- **Store distribution (optional, only if one-click install for non-technical users becomes a goal):** the Chrome Web Store and Edge Add-ons store give a one-click "Add to Chrome/Edge" (the same Chromium build covers Brave and Vivaldi via the Chrome Web Store). Cost: a one-time developer fee, a review process, and ongoing maintenance; minimize review scrutiny by requesting `activeTab` + per-site permissions on demand. Currently out of scope — the no-store guided setup is the chosen path.

---

## 5. Optional connection escalation

A deferred, opt-in capability — never the default path:

- **`chrome.debugger` (in-extension CDP) escalation** — the only way to get truly trusted input (`isTrusted:true`) and Chrome's authoritative accessibility tree. It shows the unavoidable "started debugging this browser" banner and needs the `debugger` permission, so it is gated behind an explicit per-task opt-in, attached lazily only after a verified trusted-input failure, and restricted to an enumerated CDP verb allowlist (never `Runtime.evaluate`). For the v1 target set, almost nothing requires it.

---

## 6. Rejected alternatives (recorded for the design doc)

Documented so the design rationale is explicit and a reviewer's obvious questions are pre-answered:

- **Chrome 144 permission-gated external CDP** (`chrome://inspect#remote-debugging` + `--autoConnect`) — Google's sanctioned route back into the default profile, but it bypasses the extension entirely (no capability gate; raw CDP is an arbitrary-code channel), prompts every session, shows the automation banner, and runs on almost no installs yet. Rejected as a transport; cited as evidence that the in-extension path is the right trust boundary.
- **Pure `chrome.debugger` baseline** — always-on banner, DevTools conflict, scary permission, and overkill for a no-screenshot, no-arbitrary-code tool. Rejected; its useful subset survives as the opt-in escalation above.
- **WebDriver BiDi / WebDriver** — driver-launched, logged-*out* browser instances with no extension-side entry point; cannot reach the user's authenticated profile. Rejected.
- **External CDP via `--remote-debugging-port`** — blocked on the default profile since Chrome 136; reaches only a fresh, logged-out profile. This is the constraint that makes browsight an extension in the first place.

---

*browsight roadmap — the MVP ships first ([PRD.md](PRD.md)); everything here follows, one commit at a time.*
