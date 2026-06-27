// Bundles the extension with esbuild: the service worker as an ESM module and the content script
// as a self-contained IIFE (so its npm deps are inlined for on-demand injection). esbuild is used
// here rather than the server's tsdown because it bundles multi-surface IIFE output reliably.
import { copyFile, mkdir } from "node:fs/promises";
import { build } from "esbuild";

const outdir = "dist";
await mkdir(outdir, { recursive: true });

const common = { bundle: true, target: "chrome116", logLevel: "info", legalComments: "none" };

await build({
  ...common,
  entryPoints: { "service-worker": "src/service-worker.ts" },
  outdir,
  format: "esm",
});

await build({
  ...common,
  entryPoints: { content: "src/content.ts", popup: "src/popup.ts", options: "src/options.ts" },
  outdir,
  format: "iife",
});

await copyFile("src/manifest.json", `${outdir}/manifest.json`);
await copyFile("src/popup.html", `${outdir}/popup.html`);
await copyFile("src/options.html", `${outdir}/options.html`);

console.log("extension built to ./dist");
