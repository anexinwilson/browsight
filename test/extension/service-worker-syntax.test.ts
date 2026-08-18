import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import ts from "typescript";

test("service worker has no top-level await", () => {
  const source = fs.readFileSync(
    path.join(import.meta.dirname, "../../extension/src/service-worker.ts"),
    "utf-8",
  );
  const file = ts.createSourceFile(
    "service-worker.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const topLevelAwaits: number[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) {
      return;
    }
    if (ts.isAwaitExpression(node)) {
      topLevelAwaits.push(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1);
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(file, visit);
  assert.deepEqual(topLevelAwaits, []);
});
