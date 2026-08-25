// Bundles the extension with esbuild: the service worker as an ESM module and the content script
// as a self-contained IIFE (so its npm deps are inlined for on-demand injection). esbuild is used
// here rather than the server's tsdown because it bundles multi-surface IIFE output reliably.
import { copyFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { build } from "esbuild";
import ts from "typescript";

const outdir = "dist";
await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

const common = { bundle: true, target: "chrome116", logLevel: "info", legalComments: "none" };

await build({
  ...common,
  entryPoints: { "service-worker": "src/service-worker.ts" },
  outdir,
  format: "esm",
});

const workerSource = await readFile(`${outdir}/service-worker.js`, "utf8");
const workerFile = ts.createSourceFile(
  "service-worker.js",
  workerSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS,
);
const topLevelAwaits = [];
const inspectWorker = (node) => {
  if (ts.isFunctionLike(node)) {
    return;
  }
  if (ts.isAwaitExpression(node)) {
    topLevelAwaits.push(
      workerFile.getLineAndCharacterOfPosition(node.getStart(workerFile)).line + 1,
    );
  }
  ts.forEachChild(node, inspectWorker);
};
ts.forEachChild(workerFile, inspectWorker);
if (topLevelAwaits.length > 0) {
  throw new Error(
    `service-worker.js contains top-level await on line(s) ${topLevelAwaits.join(", ")}`,
  );
}

await build({
  ...common,
  entryPoints: { content: "src/content.ts" },
  outdir,
  format: "iife",
});

await build({
  ...common,
  entryPoints: { popup: "src/popup.ts", options: "src/options.ts" },
  outdir,
  format: "esm",
});

// The version lives only in the root package.json and is stamped in here. The source manifest
// deliberately carries no version field: a second copy drifted, and a manifest claiming one version
// while the server reported another is exactly what `browser_status` warns users about.
const manifest = JSON.parse(await readFile("src/manifest.json", "utf8"));
const { version } = JSON.parse(await readFile("../package.json", "utf8"));
await writeFile(
  `${outdir}/manifest.json`,
  `${JSON.stringify({ ...manifest, version }, null, 2)}
`,
);
await copyFile("src/popup.html", `${outdir}/popup.html`);
await copyFile("src/options.html", `${outdir}/options.html`);
await cp("src/icons", `${outdir}/icons`, { recursive: true });

console.log("extension built to ./dist");
