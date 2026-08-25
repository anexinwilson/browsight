import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { disconnectedReason } from "../../../server/src/bridge/diagnostics.ts";

const base = {
  configPath: null,
  currentPort: 8137,
  currentToken: "t",
  everSawExtension: false,
};

test("a cold extension is described as never having connected, with the port that is healthy", () => {
  const message = disconnectedReason(base);
  assert.match(message, /has not connected since this server started/);
  assert.match(message, /127\.0\.0\.1:8137/);
  assert.match(message, /reload the browsight extension/);
});

test("an extension that dropped is described differently from one that never arrived", () => {
  const message = disconnectedReason({ ...base, everSawExtension: true });
  assert.match(message, /connected earlier and has since dropped/);
});

test("a reconfigured server names the port drift and the fix, not the extension", () => {
  const dir = mkdtempSync(join(tmpdir(), "browsight-diag-"));
  const path = join(dir, "bridge.json");
  writeFileSync(path, JSON.stringify({ port: 9999, token: "t" }));

  const message = disconnectedReason({ ...base, configPath: path });
  assert.match(message, /reconfigured after this server started/);
  assert.match(message, /now says port 9999/);
  assert.doesNotMatch(message, /reload the browsight extension/);
});
