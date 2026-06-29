# Browsight Search Fallback
When using the `browsight` MCP to search on a website, if filling a search box doesn't automatically trigger the search, use `browser_act` with `action: navigate` to the direct search URL instead of struggling with UI buttons.

# Scratch Folder Enforcement
To maintain a clean repository, NEVER place temporary, throwaway, or junk files in the root or random directories. All such files MUST be placed in the `scratch/` folder.

# DevSecOps Portfolio Standard
When implementing CI/CD and security pipelines for portfolio projects:
1. **Security Tooling:** Implement **CodeQL** for deep custom-code static analysis (SAST) AND **Snyk** for dependency/SCA scanning. This dual approach proves mastery of both GitHub-native AppSec and industry-standard developer-first security.
2. **NPM Publishing:** Always use **NPM Provenance** via **Trusted Publishers (OIDC)** in GitHub Actions. Never use long-lived NPM tokens as secrets. This demonstrates cutting-edge supply chain security knowledge.

# Secure Messaging Mandate (Snyk SAST Compliance)
Whenever implementing `window.postMessage`, `chrome.runtime.onMessageExternal`, or `WebSocket` message listeners:
1. **Always validate the origin**: You MUST check `event.origin` against an explicit allowlist or trusted URL before processing `event.data`. Do not use `.includes()` or `.startsWith()` as they are vulnerable to spoofing. Use strict equality `===`.
2. **Fail closed**: If the origin does not match the expected trusted source, the event handler must immediately `return` or throw.
3. This guarantees compliance with SAST engines (like Snyk) that flag "Insufficient postMessage Validation".

# Chrome Extension IIFE Build Constraint (S7785 False Positive)
The files `extension/src/popup.ts`, `extension/src/options.ts`, and `extension/src/content.ts`
are bundled by esbuild into **IIFE format** (`format: "iife"` in `extension/build.mjs`).

**Top-level `await` is a language-level impossibility in IIFE bundles.**

1. **NEVER** attempt to apply SonarQube S7785 ("Prefer top-level await") to these files. Doing so crashes the build with `Top-level await is currently not supported with the "iife" output format`.
2. The `async function init() { ... }` + `void init()` pattern is the **ONLY valid async startup pattern** for IIFE-format Chrome Extension scripts.
3. SonarQube S7785 is a **False Positive** for these specific files. The correct resolution is to mark them as "False Positive" in the SonarCloud dashboard — NOT to change the code.
4. `extension/src/service-worker.ts` IS compiled as ESM (`format: "esm"`) and CAN use top-level await normally.
