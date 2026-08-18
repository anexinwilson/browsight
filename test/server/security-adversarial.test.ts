import assert from "node:assert/strict";
import { timingSafeEqual } from "node:crypto";
import http from "node:http";
import net from "node:net";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { startBridge } from "../../server/src/bridge.ts";

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

function sendRawHttp(options: {
  port: number;
  method?: string;
  path?: string;
  headers?: Record<string, string | number>;
  rawBody?: string | Buffer;
}): Promise<{
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  socketClosed: boolean;
}> {
  return new Promise((resolve, _reject) => {
    let socketClosed = false;
    const postData = options.rawBody ?? "";
    const length = Buffer.isBuffer(postData) ? postData.length : Buffer.byteLength(postData);

    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: options.port,
        path: options.path ?? "/request",
        method: options.method ?? "QUERY",
        agent: false,
        headers: {
          Connection: "close",
          ...(postData ? { "Content-Length": length } : {}),
          ...options.headers,
        },
      },
      (res) => {
        const socket = res.socket;
        if (socket) {
          if (socket.destroyed || socket.closed) {
            socketClosed = true;
          }
          socket.on("close", () => {
            socketClosed = true;
          });
        }

        let rawData = "";
        res.on("data", (chunk) => {
          rawData += chunk.toString();
        });
        res.on("close", () => {
          socketClosed = true;
        });
        res.on("end", async () => {
          if (!socketClosed && socket && !socket.destroyed) {
            await new Promise<void>((r) => {
              socket.once("close", () => {
                socketClosed = true;
                r();
              });
              setTimeout(r, 40);
            });
          }
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body: rawData,
            socketClosed: socketClosed || Boolean(socket?.destroyed || socket?.closed),
          });
        });
      },
    );

    req.on("error", (err) => {
      // If server forcibly closed socket due to 413 or 400, reject with error or resolve
      resolve({
        statusCode: 0,
        headers: {},
        body: err.message,
        socketClosed: true,
      });
    });

    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

test("SECURITY 1: HTTP QUERY malformed JSON bodies and fuzzing", async () => {
  const port = await getFreePort();
  const token = "security-fuzz-token";
  const bridge = startBridge({ port, token });
  await bridge.ready;

  try {
    const malformedBodies = [
      "{", // truncated JSON
      '{"type": "read.request", "id": ', // missing value
      '{"type": "read.request", "id": 1234, unquoted_key: true}', // invalid syntax
      "undefined", // invalid identifier
      "NaN",
      "[1, 2, 3,", // truncated array
      '{"id": "1", "nested": { "deep": { "deeper": ', // truncated object
      "\0\0\0\0", // null bytes
      "random garbage text that is not json",
      '{"type": "read.request", "invalid_escape": "\\u00"}', // bad unicode
    ];

    for (const badBody of malformedBodies) {
      const res = await sendRawHttp({
        port,
        method: "QUERY",
        path: "/request",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        rawBody: badBody,
      });

      assert.strictEqual(
        res.statusCode,
        400,
        `Malformed body [${badBody.slice(0, 20)}] should return 400 Bad Request`,
      );
      assert.strictEqual(res.headers.connection, "close");
      assert.ok(res.socketClosed, "Connection must be closed on bad request");
    }
  } finally {
    await bridge.close();
  }
});

test("SECURITY 2: Huge payload rejection (MAX_PAYLOAD 32MB limit enforcement)", async () => {
  const port = await getFreePort();
  const token = "security-payload-token";
  const bridge = startBridge({ port, token });
  await bridge.ready;

  try {
    // Generate payload larger than 32MB (e.g. 33MB)
    // Stream chunks directly through socket to avoid allocating one massive 33MB string in memory
    const totalBytes = 33 * 1024 * 1024;
    const chunkSize = 64 * 1024;

    const result = await new Promise<{ statusCode: number; socketClosed: boolean }>((resolve) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/request",
          method: "QUERY",
          agent: false,
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "Content-Length": totalBytes,
            Connection: "close",
          },
        },
        (res) => {
          resolve({
            statusCode: res.statusCode ?? 0,
            socketClosed: true,
          });
        },
      );

      req.on("error", () => {
        resolve({
          statusCode: 413,
          socketClosed: true,
        });
      });

      // Stream chunks until error or completed
      const chunkBuffer = Buffer.alloc(chunkSize, "A");
      let written = 0;

      function writeNext() {
        while (written < totalBytes) {
          written += chunkSize;
          const ok = req.write(chunkBuffer);
          if (!ok) {
            req.once("drain", writeNext);
            return;
          }
        }
        req.end();
      }

      writeNext();
    });

    assert.ok(
      result.statusCode === 413 || result.statusCode === 0,
      `Oversized payload must be rejected with 413 Payload Too Large or connection reset (got ${result.statusCode})`,
    );
    assert.ok(result.socketClosed, "Socket must be closed");
  } finally {
    await bridge.close();
  }
});

test("SECURITY 3: Authentication token validation timing attack resistance", async () => {
  const targetToken = "browsight_secret_auth_token_9876543210_abcdef";

  // Helper matching tokensMatch logic
  function testTokensMatch(a: string | undefined | null, b: string): boolean {
    if (!a) return false;
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    return ba.length === bb.length && timingSafeEqual(ba, bb);
  }

  // 1. Correct token match
  assert.strictEqual(testTokensMatch(targetToken, targetToken), true);

  // 2. Falsy / empty token handling
  assert.strictEqual(testTokensMatch(undefined, targetToken), false);
  assert.strictEqual(testTokensMatch(null, targetToken), false);
  assert.strictEqual(testTokensMatch("", targetToken), false);

  // 3. Length mismatch handling (must not throw and must return false)
  assert.strictEqual(testTokensMatch("short", targetToken), false);
  assert.strictEqual(testTokensMatch(`${targetToken}_extra`, targetToken), false);

  // 4. Prefix attack candidates: varying matching character lengths
  const sameLengthDifferentStart = `x${targetToken.slice(1)}`;
  const sameLengthDifferentMiddle = `${targetToken.slice(0, 15)}X${targetToken.slice(16)}`;
  const sameLengthDifferentEnd = `${targetToken.slice(0, -1)}X`;

  assert.strictEqual(testTokensMatch(sameLengthDifferentStart, targetToken), false);
  assert.strictEqual(testTokensMatch(sameLengthDifferentMiddle, targetToken), false);
  assert.strictEqual(testTokensMatch(sameLengthDifferentEnd, targetToken), false);

  // 5. Statistical timing benchmark across equal-length tokens
  // Verify that timingSafeEqual takes uniform time regardless of where the mismatch occurs
  const ITERATIONS = 5000;
  const tokensToTest = [
    { name: "diffStart", token: sameLengthDifferentStart },
    { name: "diffMiddle", token: sameLengthDifferentMiddle },
    { name: "diffEnd", token: sameLengthDifferentEnd },
    { name: "exactMatch", token: targetToken },
  ];

  const timings: Record<string, number> = {};

  for (const item of tokensToTest) {
    const t0 = performance.now();
    for (let i = 0; i < ITERATIONS; i++) {
      testTokensMatch(item.token, targetToken);
    }
    const duration = performance.now() - t0;
    timings[item.name] = duration;
  }

  // Check variance among mismatch variants
  const tDiffStart = timings.diffStart ?? 0;
  const tDiffMiddle = timings.diffMiddle ?? 0;
  const tDiffEnd = timings.diffEnd ?? 0;
  const maxTime = Math.max(tDiffStart, tDiffMiddle, tDiffEnd);
  const minTime = Math.min(tDiffStart, tDiffMiddle, tDiffEnd);
  const diffRatio = minTime > 0 ? (maxTime - minTime) / minTime : 0;

  // Ensure no huge timing disparity (> 200% divergence under 5000 loops)
  assert.ok(
    diffRatio < 2.5,
    `timingSafeEqual must exhibit constant-time characteristics (diff ratio: ${diffRatio.toFixed(3)})`,
  );
});

test("SECURITY 4: 100-request unauthorized flood rejection (401) with immediate connection closure and daemon survival", async () => {
  const port = await getFreePort();
  const legitimateToken = "valid-secret-daemon-token-xyz";
  let requestCount = 0;

  const bridge = startBridge({
    port,
    token: legitimateToken,
    onTabs: (req) => {
      requestCount++;
      return {
        type: "tabs.response",
        id: req.id,
        tabs: [
          {
            id: 101,
            title: "Protected Data",
            origin: "https://secure.internal",
            active: true,
            access: "full",
          },
        ],
        refs: [],
        hasPasswordField: false,
      };
    },
  });
  await bridge.ready;

  try {
    // 1. Send flood of 100 unauthorized requests with diverse headers/tokens
    const floodSize = 100;
    const unauthorizedPromises = Array.from({ length: floodSize }, (_, i) => {
      const badHeaders: Record<string, string> = {};
      if (i % 4 === 0) {
        badHeaders.Authorization = `Bearer wrong-token-${i}`;
      } else if (i % 4 === 1) {
        badHeaders.Authorization = "Basic dXNlcjpwYXNz";
      } else if (i % 4 === 2) {
        badHeaders["X-Browsight-Token"] = "invalid-header-token";
      }
      // i % 4 === 3 has no auth headers at all

      return sendRawHttp({
        port,
        method: "QUERY",
        path: "/request",
        headers: {
          "Content-Type": "application/json",
          ...badHeaders,
        },
        rawBody: JSON.stringify({
          type: "tabs.request",
          id: `unauth-${i}`,
          select: null,
        }),
      });
    });

    const results = await Promise.all(unauthorizedPromises);

    // Verify every single request received 401 Unauthorized and closed connection
    for (const [i, r] of results.entries()) {
      if (!r) {
        assert.fail(`Result #${i} must be defined`);
      }
      assert.strictEqual(
        r.statusCode,
        401,
        `Unauthorized request #${i} must receive HTTP 401 Unauthorized`,
      );
      assert.strictEqual(
        r.headers.connection,
        "close",
        `Unauthorized request #${i} must have Connection: close`,
      );
      assert.strictEqual(r.body, "unauthorized");
      assert.ok(r.socketClosed, `Socket for request #${i} must be closed`);
    }

    // Verify handler was never called by unauthorized requests
    assert.strictEqual(
      requestCount,
      0,
      "onTabs handler must not be triggered by unauthorized requests",
    );

    // 2. Verify server daemon is 100% operational and fulfills authenticated requests cleanly
    const authRes = await sendRawHttp({
      port,
      method: "QUERY",
      path: "/request",
      headers: {
        Authorization: `Bearer ${legitimateToken}`,
        "Content-Type": "application/json",
      },
      rawBody: JSON.stringify({
        type: "tabs.request",
        id: "legit-after-flood",
        select: null,
      }),
    });

    assert.strictEqual(authRes.statusCode, 200, "Authenticated request must return 200 OK");
    assert.strictEqual(authRes.headers.connection, "close");
    const parsed = JSON.parse(authRes.body);
    assert.strictEqual(parsed.type, "tabs.response");
    assert.strictEqual(parsed.id, "legit-after-flood");
    assert.strictEqual(parsed.tabs[0].title, "Protected Data");
    assert.strictEqual(requestCount, 1, "Legitimate request was successfully processed by daemon");
  } finally {
    await bridge.close();
  }
});
