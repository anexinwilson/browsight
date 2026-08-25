/**
 * Owning the loopback listener: binding it, reporting the port it actually holds, and moving it to
 * a new port without dropping the old one until the new one is up.
 *
 * The move matters because `setup` can rewrite the port while a server is running. Checking whether
 * a port is free before binding would race — the only reliable test is the bind itself — so the
 * replacement listener is bound first and the old one is only closed once the new one is listening.
 * A failed move therefore leaves a working bridge rather than none.
 */
import * as http from "node:http";
import { errorCode } from "../utils/errors.ts";

export type RequestHandler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

export interface Listener {
  /** Resolves once bound, rejects with a human-readable reason if the port is unavailable. */
  readonly ready: Promise<void>;
  /** The port actually bound. With port 0 the OS chooses, so this can differ from the request. */
  port(): number;
  /** Why the listener is unusable, or null while it is healthy. */
  error(): string | null;
  /** Bind `port` and retire the current listener. Throws if the new port cannot be bound. */
  moveTo(port: number): Promise<void>;
  close(): Promise<void>;
}

/** Turn a listen failure into something a user can act on. */
export function describeListenError(err: Error, host: string, port: number): string {
  return errorCode(err) === "EADDRINUSE"
    ? `another browsight instance is already using ${host}:${port}, only one client can drive browsight at a time; close it in the other client, or drive browsight from there.`
    : `the browsight bridge could not start: ${err.message}`;
}

function bind(handler: RequestHandler, host: string, port: number): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const candidate = http.createServer(handler);
    const onError = (err: Error) => {
      candidate.close();
      reject(err);
    };
    candidate.once("error", onError);
    candidate.listen({ host, port }, () => {
      candidate.removeListener("error", onError);
      resolve(candidate);
    });
  });
}

function shutdown(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

export function startListener(handler: RequestHandler, host: string, port: number): Listener {
  let requestedPort = port;
  let listenError: string | null = null;
  let resolveReady!: () => void;
  let rejectReady!: (err: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  let server = http.createServer(handler);
  server.listen({ host, port: requestedPort }, () => resolveReady());
  server.on("error", (err: Error) => {
    listenError = describeListenError(err, host, requestedPort);
    rejectReady(new Error(listenError));
  });

  return {
    ready,
    port() {
      const bound = server.address();
      return typeof bound === "object" && bound ? bound.port : requestedPort;
    },
    error() {
      return listenError;
    },
    async moveTo(next) {
      const replacement = await bind(handler, host, next);
      const previous = server;
      server = replacement;
      requestedPort = next;
      await shutdown(previous);
      listenError = null;
    },
    close() {
      return shutdown(server);
    },
  };
}
