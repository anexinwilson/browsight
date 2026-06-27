/**
 * The permission policy — pure decision logic, with no `chrome.*` access, so it can be unit-tested
 * in isolation. Storage and the host-permission requests live in `permissions.ts`.
 */

export type Tier = "read" | "full";

export interface Grant {
  readonly origin: string;
  readonly tier: Tier;
  /** Epoch ms at which the grant expires, or `null` for a persistent grant. */
  readonly expiresAt: number | null;
}

export interface Access {
  readonly read: boolean;
  readonly act: boolean;
}

const DENIED: Access = { read: false, act: false };

/** Decide what `origin` is allowed right now, given the stored grants and the current time. */
export function decideAccess(grants: readonly Grant[], origin: string, now: number): Access {
  const grant = grants.find(
    (g) => g.origin === origin && (g.expiresAt === null || g.expiresAt > now),
  );
  if (!grant) {
    return DENIED;
  }
  return { read: true, act: grant.tier === "full" };
}

/** Available expiry durations for a grant, in milliseconds (or `null` for never). */
export const TIMER_OPTIONS: ReadonlyArray<{ label: string; ms: number | null }> = [
  { label: "1 hour", ms: 60 * 60 * 1000 },
  { label: "2 hours", ms: 2 * 60 * 60 * 1000 },
  { label: "4 hours", ms: 4 * 60 * 60 * 1000 },
  { label: "12 hours", ms: 12 * 60 * 60 * 1000 },
  { label: "1 day", ms: 24 * 60 * 60 * 1000 },
  { label: "Never", ms: null },
];
