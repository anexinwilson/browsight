import assert from "node:assert/strict";
import { test } from "node:test";

const logged: unknown[][] = [];
const originalConsoleError = console.error;
console.error = (...values: unknown[]) => {
  logged.push(values);
};

globalThis.chrome = {
  runtime: {
    getURL: () => "chrome-extension://test/connection.json",
    getManifest: () => ({ version: "0.1.4" }),
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
  },
  alarms: {
    create() {},
    onAlarm: { addListener() {} },
  },
} as unknown as typeof chrome;

globalThis.fetch = (async (url: string) => {
  if (String(url).endsWith("connection.json")) {
    return {
      json: async () => ({ host: "127.0.0.1", port: 60928, token: "test-token" }),
    } as unknown as Response;
  }
  // Simulate auth/SSE endpoint being unreachable, triggers connection failure
  throw new Error("socket construction failed");
}) as unknown as typeof fetch;

await import("../../extension/src/service-worker.ts");

test("service worker reports a startup connection failure", () => {
  try {
    assert.equal(logged.length, 1);
    assert.equal(logged[0]?.[0], "browsight connection failed");
    assert.match(String(logged[0]?.[1]), /socket construction failed/);
  } finally {
    console.error = originalConsoleError;
  }
});
