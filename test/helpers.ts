/**
 * Shared, typed helpers for the integration tests.
 *
 * These were duplicated across several test files with no type annotations, which
 * is what let implicit `any` accumulate once the suite moved out of typecheck scope.
 */
import http from "node:http";
import net from "node:net";
import { performance } from "node:perf_hooks";

/** True if the pid exists. EPERM means it exists but belongs to another user. */
export function isPidAlive(pid: number | undefined): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException | undefined)?.code === "EPERM";
  }
}

/** True if something is accepting connections on the loopback port. */
export function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
  });
}

/**
 * Binds port 0 to let the OS pick a free port, then releases it.
 *
 * Inherently racy, the port can be taken between release and reuse, so prefer
 * binding directly where the code under test allows it.
 */
export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface HttpQueryOptions {
  readonly port: number;
  readonly token?: string;
  readonly path?: string;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
  readonly method?: string;
}

export interface HttpQueryResult {
  readonly statusCode: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
  readonly json: Record<string, unknown> | null;
  readonly socketClosed: boolean;
  readonly durationMs: number;
}

/** Issues one HTTP QUERY request and reports how the server closed it. */
export function sendHttpQuery(options: HttpQueryOptions): Promise<HttpQueryResult> {
  const { port, token, path = "/request", body, headers = {}, method = "QUERY" } = options;
  return new Promise((resolve, reject) => {
    const postData = typeof body === "string" ? body : JSON.stringify(body ?? {});
    const startTime = performance.now();
    let socketClosed = false;

    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        agent: false,
        headers: {
          Connection: "close",
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(postData),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk.toString();
        });
        res.socket?.on("close", () => {
          socketClosed = true;
        });
        res.on("close", () => {
          socketClosed = true;
        });
        res.on("end", async () => {
          let json: Record<string, unknown> | null = null;
          try {
            json = JSON.parse(data) as Record<string, unknown>;
          } catch {
            json = null;
          }
          // `end` can fire just before the socket finishes closing, so give the
          // close event a brief chance to land before reporting on it.
          const socket = res.socket;
          if (!socketClosed && socket && !socket.destroyed) {
            await new Promise<void>((settle) => {
              socket.once("close", () => {
                socketClosed = true;
                settle();
              });
              setTimeout(settle, 40);
            });
          }
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body: data,
            json,
            socketClosed: socketClosed || Boolean(res.socket?.destroyed),
            durationMs: performance.now() - startTime,
          });
        });
      },
    );

    req.on("error", reject);
    if (postData) req.write(postData);
    req.end();
  });
}
