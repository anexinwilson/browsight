# Contributing to Browsight

## Local setup

Install Node.js 24 and Google Chrome, then run:

```sh
npm install
npm run hooks # optional: enable the repository's pre-commit checks
npm run build
npm run setup
```

The setup command copies the extension to `~/.browsight/extension`. Load that directory from `chrome://extensions` with Developer mode enabled.

## Quality checks

Run all checks before opening a pull request:

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm pack --dry-run
```

Temporary files, local fixtures, test configuration, and generated reports belong under the ignored `scratch/` directory. Do not add them to the repository root.

## Code conventions

- Use strict TypeScript and ESM.
- Validate data at process boundaries.
- Keep permission decisions in the extension, which is the component with page access.
- Keep the bridge protocol in `shared/src/protocol.ts`.
- Separate pure decision logic from browser, file-system, and network access.
- Name tests after observable behavior rather than implementation lines or coverage targets.
- Explain security decisions and browser workarounds in comments. Avoid comments that repeat the code.

The popup, options page, and service worker are bundled as ESM. The content script is bundled as an IIFE because Chrome injects it directly into pages.

The WebSocket bridge must remain restricted to explicit loopback hosts and validated ports. Validate every incoming bridge message before dispatch.

## Releases

CI runs type checking, linting, tests, builds, static analysis, and dependency scanning. npm publishing uses trusted publishing with OIDC and provenance. Do not add long-lived npm publishing tokens.
