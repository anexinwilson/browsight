/**
 * The server's end of the stream the extension listens on.
 *
 * Chrome's service worker opens one long-lived SSE request and the server pushes messages down it.
 * That makes the stream the single place that knows whether the extension is reachable, so the
 * connection state, the waiters for it, and the writes to it belong together rather than as three
 * separate variables in the bridge's closure.
 */

import type * as http from "node:http";
import type { BridgeMessage } from "@browsight/shared";

export interface ExtensionChannel {
  /** Adopt a new stream as the live one, retiring any previous stream first. */
  attach(res: http.ServerResponse, req: http.IncomingMessage, onDetach: () => void): void;
  /** Push a message to the extension. Throws when nothing is attached. */
  send(message: BridgeMessage): void;
  isConnected(): boolean;
  /** Resolve as soon as a stream attaches, or false once `timeoutMs` passes. */
  awaitConnection(timeoutMs: number): Promise<boolean>;
  /** Drop the stream and release anything waiting on it. */
  close(): void;
}

function writeEvent(res: http.ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function createExtensionChannel(): ExtensionChannel {
  let stream: http.ServerResponse | null = null;
  let waiters: Array<(connected: boolean) => void> = [];

  /**
   * Release everyone waiting for a connection.
   *
   * This used to be missing on the attach path: waiters were only drained on shutdown, so a caller
   * that arrived before the extension waited the entire window and then discovered the stream had
   * been live nearly the whole time. Every cold start paid the full timeout.
   */
  const releaseWaiters = (connected: boolean): void => {
    const pendingWaiters = waiters;
    waiters = [];
    for (const wake of pendingWaiters) {
      wake(connected);
    }
  };

  return {
    attach(res, req, onDetach) {
      if (stream && stream !== res) {
        try {
          writeEvent(stream, "close", {
            reason: "replaced by a newer extension connection",
          });
          stream.end();
        } catch {
          // The previous stream is already gone; adopting the new one is what matters.
        }
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "close",
      });
      res.write(": connected\n\n");
      stream = res;
      releaseWaiters(true);

      let detached = false;
      const handleDisconnect = () => {
        if (detached) {
          return;
        }
        detached = true;
        if (stream === res) {
          stream = null;
          onDetach();
        }
      };

      req.on("close", handleDisconnect);
      req.on("aborted", handleDisconnect);
      res.on("close", handleDisconnect);
      req.socket?.on("close", handleDisconnect);
    },

    send(message) {
      if (!stream) {
        throw new Error("the browsight extension is not connected");
      }
      writeEvent(stream, "message", message);
    },

    isConnected() {
      return stream !== null;
    },

    awaitConnection(timeoutMs) {
      if (stream) {
        return Promise.resolve(true);
      }
      return new Promise((resolve) => {
        let settled = false;
        const finish = (connected: boolean) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          resolve(connected);
        };
        const timer = setTimeout(() => finish(false), timeoutMs);
        timer.unref?.();
        waiters.push(finish);
      });
    },

    close() {
      // Anything waiting must be released here, or a shutdown hangs for the full window on a
      // connection that is never going to arrive.
      releaseWaiters(false);
      if (stream) {
        try {
          stream.end();
        } catch {
          // Already closed by the peer.
        }
        stream = null;
      }
    },
  };
}
