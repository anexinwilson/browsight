import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

test("service worker has no top-level await", () => {
  const source = readFileSync(new URL("./service-worker.ts", import.meta.url), "utf8");
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
