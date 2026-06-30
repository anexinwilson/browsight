# Original User Request

## Initial Request — 2026-06-30T03:57:20+05:30

Fix all 54 remaining SonarCloud Code Analysis issues (Vulnerabilities and Code Smells) across the browsight-mcp repository. Ensure all fixes are compliant with modern best practices, using non-deprecated methods and secure configurations.

Working directory: c:/Users/aen/Music/browsight-mcp

## Requirements

### R1. Secure GitHub Actions Workflows
Update all GitHub Actions workflows (`ci.yml`, `gitleaks.yml`, `publish.yml`, `snyk.yml`, `sonarcloud.yml`) to:
- Use `--ignore-scripts` with `npm ci` and `npx` commands (Sonar S6505).
- Use full commit SHA hashes for all third-party actions instead of tags.

### R2. Refactor Extension Code for Maintainability
Fix code smells in the `extension/` directory, specifically:
- Replace `window` with `globalThis`.
- Fix Cognitive Complexity warnings in `act.ts` and `snapshot.ts`.
- Use nullish coalescing (`??=`) where appropriate.
- Fix HTML accessibility issues (`<title>` tags and valid `<label>` associations in `options.html` and `popup.html`).
- Note: `popup.ts` and `options.ts` use IIFE formats which do not support top-level await. These specific warnings (S7785) might be false positives that need to be explicitly documented or handled according to project rules.

### R3. Modernize Scripts and Server Code
Fix code smells in `scripts/setup.ts` and the `server/` directory:
- Use `replaceAll()` instead of `replace()` for global string replacements.
- Fix regex backtracking performance (S8786).
- Use `String.raw` to avoid excessive escaping.
- Avoid nested template literals and deep function nesting.
- Fix `[object Object]` stringification in `server/src/bridge.ts` by properly extracting or stringifying the object properties.
- Use top-level await where appropriate (in ESM modules).

## Acceptance Criteria

### Security and Standards
- [ ] All `npm ci` commands in `.github/workflows/*.yml` use `--ignore-scripts`.
- [ ] All GitHub Actions use pinned SHA hashes.
- [ ] No `[object Object]` implicit stringification in `bridge.ts`.

### Build and Tests
- [ ] `npm run typecheck` passes with 0 errors.
- [ ] `npm run lint` passes with 0 errors.
- [ ] `npm test` passes and coverage is successfully generated.
- [ ] `npm run build` completes successfully.

## Follow-up — 2026-06-29T22:39:21Z

Fix all remaining SonarCloud code smells and increase test coverage to ≥ 80% across the codebase, specifically targeting the un-tested files in `extension/src` (using `jsdom` for mocking).

Working directory: c:\Users\aen\Music\browsight-mcp
Integrity mode: development

## Requirements

### R1. Achieve 80% Test Coverage on New Code
Write unit tests using Node.js's native `node:test` runner to increase the overall test coverage of the recently added files. Specifically target files like `extension/src/service-worker.ts`, `extension/src/acting/act.ts`, and `scripts/setup.ts`.
* Note: `jsdom` is already installed in `devDependencies` and can be used to mock the DOM for extension files.

### R2. Fix Remaining Code Smells
Resolve the remaining SonarCloud warnings in the codebase, which include but are not limited to:
- Replacing `window` with `globalThis` in `content.ts` and `act.ts`.
- Reducing Cognitive Complexity in complex functions.
- Resolving top-level await warnings (S7785).
- Adding proper `<label>` and `<title>` tags to HTML files.

### R3. Strict Local-Only Constraint
Do NOT run `git push`. All commits must remain local. You may run `git add` and `git commit` to save progress locally, but you must never push to the remote repository.

## Acceptance Criteria

### Coverage & Smells
- [ ] Running `npm run test -- --experimental-test-coverage --test-reporter=lcov` results in an `lcov.info` file demonstrating ≥ 80% line coverage for the target files.
- [ ] Running `npm run lint` (`biome check`) passes with 0 errors.
- [ ] No `git push` commands are executed in any terminal logs.

## Follow-up — 2026-06-30T04:38:25+05:30

You are responsible for writing unit tests using `node:test` (and `assert`) to achieve >= 80% coverage for the following server and script files:
1. `server/src/index.ts`
2. `server/src/bridge.ts`
3. `server/src/extract.ts`
4. `scripts/setup.ts`

Working directory: `c:\Users\aen\Music\browsight-mcp`
You may run `npm run test` to verify your coverage (look at the `lcov.info` output or standard test output).
Mock the Node `fs` and `os` functions using `mock.method` as needed to avoid actual file system mutation during testing.
Report back when coverage for these 4 files is >= 80%. Do not git commit.

## Follow-up — 2026-06-30T04:38:25Z

You are responsible for writing unit tests using `node:test`, `assert`, and `jsdom` to achieve >= 80% coverage for the following Extension files:
1. `extension/src/perception/snapshot.ts`
2. `extension/src/service-worker.ts`

Working directory: `c:\Users\aen\Music\browsight-mcp`
`jsdom` is already installed. Use it to mock the DOM for `snapshot.ts`.
You will also need to heavily mock the global `chrome` API object for `service-worker.ts` to simulate extension events and storage access.
You may run `npm run test` to verify your coverage.
Report back when coverage for these 2 files is >= 80%. Do not git commit.


## Follow-up — 2026-06-30T04:38:25+05:30

You are responsible for writing unit tests using `node:test`, `assert`, and `jsdom` to achieve >= 80% coverage for the following Extension Messaging & Content files:
1. `extension/src/content.ts`
2. `extension/src/messaging/act.ts`
3. `extension/src/messaging/common.ts`
4. `extension/src/messaging/tabs.ts`
5. `extension/src/acting/act.ts`

Working directory: `c:\Users\aen\Music\browsight-mcp`
`jsdom` is already installed. Use it to mock the DOM for these frontend files. You may also need to stub the global `chrome` object.
You may run `npm run test` to verify your coverage.
Report back when coverage for these 5 files is >= 80%. Do not git commit.

## Follow-up — 2026-06-30T17:17:21Z

# Teamwork Project Prompt — Draft

> Status: Launched
> Goal: Craft prompt → get user approval → delegate to teamwork_preview

Audit the test suite for the `browsight` project to ensure the recent `npx` refactoring in `scripts/setup.ts` is fully covered, and fix any coverage gaps.

Working directory: c:\Users\aen\Music\browsight-mcp

## Requirements

### R1. Audit `npx` test coverage
The team must run coverage reports specifically targeting `scripts/setup.ts` to see if the new `npx` (and local path fallback) logic is actually being tested.

### R2. Write missing tests
Write new unit tests using `node:test` in `scripts/setup.test.ts` to cover any uncovered lines in the setup script, specifically the new `extensionHome` and path resolution logic.

## Acceptance Criteria

### Test Coverage
- [ ] Running `npm run test -- --experimental-test-coverage` shows 100% coverage for `scripts/setup.ts`.
- [ ] All 112+ tests pass successfully.
