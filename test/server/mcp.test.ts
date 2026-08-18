import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ActResponse, ReadResponse, Ref, TabsResponse } from "@browsight/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Bridge } from "../../server/src/bridge.ts";
import {
  compareVersions,
  createMcpServer,
  formatActResponse,
  isStaleBuild,
} from "../../server/src/mcp.ts";

function ref(id: number, name: string): Ref {
  return {
    id,
    role: "button",
    name,
    recipe: { role: "button", name, dataAttrs: {}, text: name, ordinal: 0 },
  };
}

test("action output caps diffs and only returns relevant fresh references", () => {
  const appeared = Array.from(
    { length: 20 },
    (_, index) => `button ${JSON.stringify(`New ${index}`)}`,
  );
  const response: ActResponse = {
    type: "act.response",
    id: "1",
    verdict: "dom_changed",
    diff: { appeared, removed: [], changed: [] },
    refs: [
      ...Array.from({ length: 20 }, (_, index) => ref(index + 1, `New ${index}`)),
      ref(100, "Unchanged navigation"),
    ],
  };
  const output = formatActResponse(response);
  assert.match(output, /\(\+12 more\)/);
  assert.match(output, /New 0/);
  assert.doesNotMatch(output, /Unchanged navigation/);
  assert.ok(output.length < 1000);
});

test("action output matches references for counted duplicate diffs", () => {
  const response: ActResponse = {
    type: "act.response",
    id: "2",
    verdict: "dom_changed",
    diff: { appeared: ['button "Reply" (x2)'], removed: [], changed: [] },
    refs: [ref(1, "Reply"), ref(2, "Reply")],
  };
  const output = formatActResponse(response);
  assert.match(output, /#1/);
  assert.match(output, /#2/);
});

test("action output stays minimal when the page did not change", () => {
  const response: ActResponse = {
    type: "act.response",
    id: "3",
    verdict: "no_change",
    diff: { appeared: [], removed: [], changed: [] },
    refs: [],
  };
  assert.equal(formatActResponse(response), "no_change");
});

function textFrom(result: unknown): string {
  assert.ok(result && typeof result === "object");
  const content = (result as { content?: unknown }).content;
  assert.ok(Array.isArray(content));
  const block = content[0] as { type?: string; text?: string } | undefined;
  assert.equal(block?.type, "text");
  return block?.type === "text" && typeof block.text === "string" ? block.text : "";
}

test("MCP tools expose compact read, act, and tab results through the protocol", async () => {
  let activityCount = 0;
  const calls: Array<{ method: string; value: unknown }> = [];
  const emptyDiff = { appeared: [], removed: [], changed: [] };
  const bridge: Bridge = {
    ready: Promise.resolve(),
    status: () => ({
      extensionConnected: true,
      detail: "extension connected",
      port: 0,
      configPort: null,
      extensionVersion: null,
      activeGrants: 0,
    }),
    reloadConfig: async () => ({ changed: false, detail: "test bridge" }),
    async readActiveTab(url): Promise<ReadResponse> {
      calls.push({ method: "read", value: url });
      if (url === "https://denied.example") {
        return {
          type: "read.response",
          id: "read-denied",
          markdown: "",
          refs: [],
          hasPasswordField: false,
          sentinel: { kind: "not_whitelisted", hint: "allow this site" },
        };
      }
      if (url === "https://login.example") {
        return {
          type: "read.response",
          id: "read-login",
          markdown: "<!-- page-load:1 (changes on reload/navigate) -->\nSign in with your password",
          refs: [],
          hasPasswordField: true,
        };
      }
      return {
        type: "read.response",
        id: "read-ok",
        markdown: "Account key sk-123456789012 dashboard",
        refs: [],
        hasPasswordField: false,
      };
    },
    async actActiveTab(request): Promise<ActResponse> {
      calls.push({ method: "act", value: request });
      if (request.ref === "blocked") {
        return {
          type: "act.response",
          id: "act-blocked",
          verdict: "no_change",
          diff: emptyDiff,
          refs: [],
          sentinel: { kind: "not_actionable", hint: "control is disabled" },
        };
      }
      return {
        type: "act.response",
        id: "act-ok",
        verdict: "dom_changed",
        diff: { appeared: ['button "Saved"'], removed: [], changed: [] },
        refs: [ref(7, "Saved")],
      };
    },
    async listTabs(select): Promise<TabsResponse> {
      calls.push({ method: "tabs", value: select });
      const tabs = [
        {
          id: 3,
          title: "Docs",
          origin: "https://docs.example",
          active: select !== "Docs",
          access: "full" as const,
        },
      ];
      if (select === "Denied") {
        return {
          type: "tabs.response",
          id: "tabs-denied",
          tabs,
          refs: [],
          hasPasswordField: false,
          sentinel: { kind: "not_whitelisted", hint: "allow the selected tab" },
        };
      }
      if (select === "Docs") {
        return {
          type: "tabs.response",
          id: "tabs-switched",
          tabs,
          switchedTo: "Docs",
          markdown: "Docs Bearer hidden-value-token",
          refs: [],
          hasPasswordField: false,
        };
      }
      return {
        type: "tabs.response",
        id: "tabs-list",
        tabs,
        refs: [],
        hasPasswordField: false,
      };
    },
    async close(): Promise<void> {},
  };

  const server = createMcpServer(bridge, () => {
    activityCount += 1;
  });
  const client = new Client({ name: "mcp-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    assert.match(
      textFrom(await client.callTool({ name: "browser_read", arguments: {} })),
      /Token estimate/,
    );
    assert.doesNotMatch(
      textFrom(await client.callTool({ name: "browser_read", arguments: {} })),
      /123456789012/,
    );
    assert.match(
      textFrom(
        await client.callTool({
          name: "browser_read",
          arguments: { url: "https://denied.example" },
        }),
      ),
      /allow this site/,
    );
    assert.match(
      textFrom(
        await client.callTool({
          name: "browser_read",
          arguments: { url: "https://login.example" },
        }),
      ),
      // The page body must still come through: a sign-in prompt is a note, not a replacement.
      /sign-in prompt is showing[\s\S]*Sign in with your password/,
    );

    assert.match(
      textFrom(
        await client.callTool({
          name: "browser_act",
          arguments: { ref: "save", action: "click", value: "now" },
        }),
      ),
      /Saved/,
    );
    assert.match(
      textFrom(
        await client.callTool({
          name: "browser_act",
          arguments: { ref: "blocked", action: "click" },
        }),
      ),
      /control is disabled/,
    );

    assert.match(textFrom(await client.callTool({ name: "browser_tabs", arguments: {} })), /Docs/);
    assert.match(
      textFrom(await client.callTool({ name: "browser_tabs", arguments: { select: "Denied" } })),
      /allow the selected tab/,
    );
    const switched = textFrom(
      await client.callTool({ name: "browser_tabs", arguments: { select: "Docs" } }),
    );
    assert.match(switched, /Switched to Docs/);
    assert.doesNotMatch(switched, /hidden-value/);

    assert.equal(activityCount, 9);
    assert.deepEqual(calls[0], { method: "read", value: null });
    assert.deepEqual(calls[4], {
      method: "act",
      value: { ref: "save", action: "click", value: "now" },
    });
  } finally {
    await client.close();
    await server.close();
  }
});

test("a version mismatch names the side that is actually stale", () => {
  assert.strictEqual(compareVersions("0.1.5", "1.0.0"), -1);
  assert.strictEqual(compareVersions("1.0.0", "0.1.5"), 1);
  assert.strictEqual(compareVersions("1.0.0", "1.0.0"), 0);
  // A string compare would put 0.10.0 below 0.9.0.
  assert.strictEqual(compareVersions("0.9.0", "0.10.0"), -1);
  assert.strictEqual(compareVersions("1.2", "1.2.0"), 0);
});

test("a rebuild after startup is detected as a stale build", () => {
  const entry = fileURLToPath(new URL("../../server/src/mcp.ts", import.meta.url));
  const mtime = statSync(entry).mtimeMs;
  // Started before the file was last written: the process is running superseded code.
  assert.strictEqual(isStaleBuild(entry, mtime - 1000), true);
  // Started after: current.
  assert.strictEqual(isStaleBuild(entry, mtime + 1000), false);
  // A missing or unknown entry must never claim staleness.
  assert.strictEqual(isStaleBuild("", 0), false);
  assert.strictEqual(isStaleBuild("no-such-file.mjs", 0), false);
});
