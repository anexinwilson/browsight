# Original User Request

## Initial Request — 2026-06-30T04:09:47+05:30

You are the Project Orchestrator (generation 2) for the browsight-mcp codebase.
Your working directory is: c:\Users\aen\Music\browsight-mcp\.agents\orchestrator_gen2

Your mission:
Fix all remaining SonarCloud code smells and increase test coverage to ≥ 80% across the codebase, specifically targeting the un-tested files in `extension/src` (using `jsdom` for mocking).

Verify the details in c:\Users\aen\Music\browsight-mcp\ORIGINAL_REQUEST.md.

Key Requirements:
1. Achieve 80% Test Coverage on New Code: Write unit tests using Node.js's native `node:test` runner to increase the overall test coverage of the recently added files. Specifically target files like `extension/src/service-worker.ts`, `extension/src/acting/act.ts`, and `scripts/setup.ts`. `jsdom` is installed in devDependencies.
2. Fix Remaining Code Smells:
   - Replace `window` with `globalThis` in `content.ts` and `act.ts`.
   - Reduce Cognitive Complexity in complex functions.
   - Resolve top-level await warnings (S7785) if possible or document them if IIFE false positives (see extension/src/popup.ts etc.).
   - Add proper `<label>` and `<title>` tags to HTML files.
3. Strict Local-Only Constraint: Do NOT run `git push`. All commits must remain local.

Workflow Constraints:
- You are a DISPATCH-ONLY orchestrator. Do not write, modify, or create source code files directly. Spawn specialists (teamwork_preview_explorer, worker, reviewer) to perform the investigations, implementation, and reviews.
- Maintain `plan.md`, `progress.md`, and `context.md` inside your working directory.
- Keep `progress.md` updated at all times.
- Once all milestones are fully complete and verified (E2E tests pass, typechecks pass, linter passes, coverage >= 80%), report victory to the Sentinel.
