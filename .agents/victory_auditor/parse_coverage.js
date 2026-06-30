import fs from "node:fs";
import path from "node:path";

const lcovPath = path.resolve("c:/Users/aen/Music/browsight-mcp/lcov.info");
const content = fs.readFileSync(lcovPath, "utf8");

const records = {};
let currentFile = null;
let lf = 0;
let lh = 0;

for (const line of content.split("\n")) {
  const trimmed = line.trim();
  if (trimmed.startsWith("SF:")) {
    currentFile = trimmed.substring(3).replace(/\\/g, "/");
    lf = 0;
    lh = 0;
  } else if (trimmed.startsWith("LF:")) {
    lf = Number.parseInt(trimmed.substring(3), 10);
  } else if (trimmed.startsWith("LH:")) {
    lh = Number.parseInt(trimmed.substring(3), 10);
  } else if (trimmed === "end_of_record") {
    if (currentFile) {
      records[currentFile] = { lf, lh, pct: lf > 0 ? (lh / lf) * 100 : 0 };
    }
    currentFile = null;
  }
}

const targets = [
  "extension/src/service-worker.ts",
  "extension/src/acting/act.ts",
  "scripts/setup.ts",
];

console.log("=== Target Coverage Report ===");
for (const target of targets) {
  const matched = Object.keys(records).find((k) => k.endsWith(target));
  if (matched) {
    const data = records[matched];
    console.log(`${target}: ${data.lh}/${data.lf} lines (${data.pct.toFixed(2)}%)`);
  } else {
    console.log(`${target}: NOT FOUND`);
  }
}

console.log("\n=== All Files Coverage ===");
let totalLf = 0;
let totalLh = 0;
for (const [file, data] of Object.entries(records)) {
  totalLf += data.lf;
  totalLh += data.lh;
  console.log(`${file}: ${data.lh}/${data.lf} lines (${data.pct.toFixed(2)}%)`);
}
const overallPct = totalLf > 0 ? (totalLh / totalLf) * 100 : 0;
console.log(`\nOverall Coverage: ${totalLh}/${totalLf} lines (${overallPct.toFixed(2)}%)`);
