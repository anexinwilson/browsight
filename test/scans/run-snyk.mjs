/**
 * Runs both halves of a Snyk scan: dependency (SCA) and static analysis (SAST).
 *
 * SAST is gated at high severity. Pass `--all-severities` to see every finding.
 */
import { spawnSync } from "node:child_process";
import { IS_WINDOWS, REPO_ROOT, requireToken } from "./lib.mjs";

const token = requireToken("SNYK_TOKEN");
const showAll = process.argv.includes("--all-severities");

function run(label, args) {
  console.log(`\n=== ${label} ===`);
  const full = ["-y", "snyk", ...args];
  const options = {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: { ...process.env, SNYK_TOKEN: token },
  };
  const result = IS_WINDOWS
    ? spawnSync(`npx ${full.join(" ")}`, { ...options, shell: true })
    : spawnSync("npx", full, options);

  if (result.error) {
    console.error(`${label} could not start: ${result.error.message}`);
    return false;
  }
  // Snyk exits 1 when it finds issues, 0 when clean.
  if (result.status !== 0) {
    console.error(`${label} FAILED (exit ${result.status}).`);
    return false;
  }
  console.log(`${label} PASSED.`);
  return true;
}

const sca = run("Snyk dependencies (SCA)", ["test", "--all-projects"]);

const sastArgs = ["code", "test"];
if (!showAll) sastArgs.push("--severity-threshold=high");
const sast = run(
  showAll ? "Snyk Code (SAST, all severities)" : "Snyk Code (SAST, high and above)",
  sastArgs,
);

if (!sca || !sast) {
  process.exit(1);
}
console.log("\nAll Snyk scans passed.");
