/** Runs the full quality gate. Stops at the first failure. */
import { spawnSync } from "node:child_process";
import { IS_WINDOWS, REPO_ROOT } from "./lib.mjs";

const steps = [
  { label: "Lint (biome)", args: ["run", "lint"] },
  { label: "Typecheck (tsc)", args: ["run", "typecheck"] },
  { label: "Tests + coverage", args: ["run", "test:coverage"] },
  // CI runs `node --test` with no tsx, so it must be exercised here or a syntax tsx tolerates
  // reaches the release pipeline and fails there instead.
  { label: "Tests as CI runs them", args: ["run", "test:ci"] },
  { label: "Snyk (SCA + SAST)", args: ["run", "scan:snyk"] },
  { label: "SonarCloud analysis", args: ["run", "scan:sonar"] },
  { label: "SonarCloud verification", args: ["run", "scan:verify"] },
];

for (const [index, step] of steps.entries()) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`[${index + 1}/${steps.length}] ${step.label}`);
  console.log("=".repeat(60));

  const result = spawnSync(IS_WINDOWS ? "npm.cmd" : "npm", step.args, {
    cwd: REPO_ROOT,
    stdio: "inherit",
    shell: IS_WINDOWS,
  });

  if (result.error || result.status !== 0) {
    console.error(`\n${step.label} FAILED, re-run it with: npm ${step.args.join(" ")}`);
    process.exit(1);
  }
}

console.log(`\n${"=".repeat(60)}`);
console.log("All checks passed.");
console.log("=".repeat(60));
