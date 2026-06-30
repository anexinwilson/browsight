# Plan: SonarCloud Smells & Coverage Optimization

## Goal
Fix remaining SonarCloud code smells and achieve >= 80% test coverage on `extension/src/service-worker.ts`, `extension/src/acting/act.ts`, and `scripts/setup.ts` using `node:test` and `jsdom`.

## Milestone 1: Exploration
- **Objective**: Establish baseline and plan exact changes/tests.
- **Tasks**:
  - Spawn `teamwork_preview_explorer_1` to find remaining smells in `extension/src/content.ts`, `extension/src/acting/act.ts`, etc.
  - Inspect current test coverage commands, setup configuration, and draft test mocks.
- **Verification**: Explorer handoff report.

## Milestone 2: Fix Code Smells
- **Objective**: Resolve targeted SonarCloud code smells.
- **Tasks**:
  - Replace `window` with `globalThis` in `content.ts` and `act.ts`.
  - Reduce cognitive complexity in complex functions.
  - Document/resolve top-level await warnings.
  - Add proper labels and titles to HTML files.
- **Verification**: Linting/typechecking pass.

## Milestone 3: Test Coverage Extension
- **Objective**: Write Node.js unit tests with `jsdom` to achieve >= 80% coverage on `service-worker.ts`, `act.ts`, and `setup.ts`.
- **Tasks**:
  - Implement tests in `extension/tests/` or standard test directory.
  - Run coverage script.
- **Verification**: Coverage report showing >= 80%.

## Milestone 4: Final Validation
- **Objective**: Full suite check.
- **Tasks**:
  - Review and challenge implementation.
  - Forensic Auditor validation.
