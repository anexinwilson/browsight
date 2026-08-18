/**
 * Submits an analysis to SonarCloud and waits for the gate to be evaluated.
 *
 * Analysis scope lives in `sonar-project.properties`. Passing scope on the command
 * line would override that file, so only identity and host properties go here.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  IS_WINDOWS,
  REPO_ROOT,
  requireToken,
  SONAR_ORGANIZATION,
  SONAR_PROJECT_KEY,
} from "./lib.mjs";

const token = requireToken("SONAR_TOKEN");

const coverage = join(REPO_ROOT, "test", "coverage", "lcov.info");
if (!existsSync(coverage)) {
  console.error("Error: test/coverage/lcov.info is missing, Sonar would report 0% coverage.");
  console.error("Run `npm run test:coverage` first.");
  process.exit(1);
}

const args = [
  "-y",
  "sonarqube-scanner",
  `-Dsonar.organization=${SONAR_ORGANIZATION}`,
  `-Dsonar.projectKey=${SONAR_PROJECT_KEY}`,
  "-Dsonar.host.url=https://sonarcloud.io",
  "-Dsonar.qualitygate.wait=true",
];

console.log("Submitting analysis to SonarCloud...");
const result = IS_WINDOWS
  ? spawnSync(`npx ${args.join(" ")}`, {
      cwd: REPO_ROOT,
      stdio: "inherit",
      shell: true,
      env: { ...process.env, SONAR_TOKEN: token },
    })
  : spawnSync("npx", args, {
      cwd: REPO_ROOT,
      stdio: "inherit",
      env: { ...process.env, SONAR_TOKEN: token },
    });

if (result.error) {
  console.error(`Scanner could not start: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) {
  console.error(`\nSonarCloud analysis failed or the quality gate is red (exit ${result.status}).`);
  console.error("Run `npm run scan:verify` to list the open issues.");
  process.exit(1);
}

console.log("\nAnalysis processed and quality gate passed.");
console.log("Run `npm run scan:verify` for the issue-level breakdown.");
