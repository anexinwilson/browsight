/**
 * The handshake `setup` writes and both sides read. Defining the shape once means the server, the
 * extension and `setup` cannot drift into disagreeing about what a valid connection looks like.
 *
 * Deliberately free of Node imports: the extension bundles this file, so it must stay browser-safe.
 */
import { z } from "zod";

/** Hosts the bridge may be reached on. A rebound hostname never resolves to one of these. */
export const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1"] as const;

export const DEFAULT_BRIDGE_HOST = "127.0.0.1";

export function isLoopbackHostname(hostname: string): boolean {
  return (LOOPBACK_HOSTS as readonly string[]).includes(hostname);
}

export const ConnectionSchema = z.object({
  // Port 0 is meaningful here: it asks the OS for any free port at bind time, which is how the
  // server starts on an ephemeral port. What setup writes for the extension is always resolved.
  port: z.number().int().min(0).max(65535),
  token: z.string().min(1),
  host: z.string().default(DEFAULT_BRIDGE_HOST),
});

export type Connection = z.infer<typeof ConnectionSchema>;

/** Parse a connection handshake, returning null rather than throwing when it is absent or invalid. */
export function parseConnection(raw: unknown): Connection | null {
  const parsed = ConnectionSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
