/**
 * The version a user sees has to be one number.
 *
 * `browser_status` compares the version the extension reports against the one the server reports,
 * and tells the user to re-run setup when they differ. Those come from different files, so a bump
 * that misses one produces a warning about a mismatch that is not real.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const REPO_ROOT = join(import.meta.dirname, "../..");
const read = (...parts: string[]): Record<string, unknown> =>
  JSON.parse(readFileSync(join(REPO_ROOT, ...parts), "utf8"));

const published = read("package.json").version as string;

test("the published version is a real semver", () => {
  assert.match(published, /^\d+\.\d+\.\d+$/);
});

test("every workspace reports the published version", () => {
  for (const workspace of ["server", "extension", "shared", "scripts"]) {
    assert.equal(
      read(workspace, "package.json").version,
      published,
      `${workspace}/package.json must match the published version`,
    );
  }
});

test("the server reports the published version to browser_status", () => {
  // mcp.ts reads server/package.json, so a root-only bump would make the server look stale.
  assert.equal(read("server", "package.json").version, published);
});

// The built manifest is not asserted here: CI runs the tests before `npm run build`, so there is
// nothing to read. The build stamps the root version in, and the source values below are what a
// bump has to keep in step.
test("the source manifest shows the published version", () => {
  // It went stale at 0.1.5 while everything else moved to 1.0.0. The build overwrites it, so the
  // drift was invisible in the shipped extension and only misled anyone reading the source.
  assert.equal(
    read("extension", "src", "manifest.json").version,
    published,
    "extension/src/manifest.json is out of date; set it to the version in package.json",
  );
});
