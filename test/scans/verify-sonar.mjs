/**
 * Queries SonarCloud for the project's open issues, unreviewed security hotspots and quality gate.
 * Exits non-zero if anything is outstanding. Hotspots come from a separate endpoint and can be
 * outstanding while the issue count is zero, so checking issues alone would miss them.
 */
import { requireToken, SONAR_ORGANIZATION, SONAR_PROJECT_KEY } from "./lib.mjs";

const token = requireToken("SONAR_TOKEN");
// SonarCloud takes the token as the HTTP Basic username with an empty password.
const auth = `Basic ${Buffer.from(`${token}:`).toString("base64")}`;

async function api(path) {
  const res = await fetch(`https://sonarcloud.io/api/${path}`, {
    headers: { Authorization: auth },
  });
  if (!res.ok) {
    throw new Error(`SonarCloud ${path} -> ${res.status} ${res.statusText}`);
  }
  return await res.json();
}

const issues = await api(
  `issues/search?componentKeys=${SONAR_PROJECT_KEY}&organization=${SONAR_ORGANIZATION}&resolved=false&ps=100`,
);
const hotspots = await api(
  `hotspots/search?projectKey=${SONAR_PROJECT_KEY}&status=TO_REVIEW&ps=100`,
);
const gate = await api(`qualitygates/project_status?projectKey=${SONAR_PROJECT_KEY}`);
const toReview = hotspots.hotspots ?? [];

console.log(`Project:      ${SONAR_PROJECT_KEY}`);
console.log(`Quality gate: ${gate.projectStatus.status}`);
console.log(`Open issues:  ${issues.total}`);
console.log(`Hotspots:     ${toReview.length} awaiting review`);

for (const issue of issues.issues) {
  const file = issue.component.replace(`${SONAR_PROJECT_KEY}:`, "");
  console.log(`  [${issue.severity}] ${file}:${issue.line ?? "?"}, ${issue.message}`);
}

for (const hotspot of toReview) {
  const file = hotspot.component.replace(`${SONAR_PROJECT_KEY}:`, "");
  console.log(`  [HOTSPOT] ${file}:${hotspot.line ?? "?"}, ${hotspot.message}`);
}

if (issues.total > 0 || toReview.length > 0 || gate.projectStatus.status === "ERROR") {
  console.error("\nFAILED, issues are still open on SonarCloud.");
  console.error(`Dashboard: https://sonarcloud.io/project/issues?id=${SONAR_PROJECT_KEY}`);
  process.exit(1);
}

console.log("\nPASSED, no open issues, quality gate green.");
