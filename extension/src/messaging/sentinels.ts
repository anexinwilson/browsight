/**
 * Reporting a dead end for an action as a typed answer rather than an error.
 *
 * An agent needs to know the difference between "the reference was stale", "the site is not
 * allowed" and "the element does not do anything", because each has a different next step. Shared
 * by the act handler and the navigation path so both report failures the same way.
 */
import type { SentinelKind } from "@browsight/shared";
import type { Send } from "./common.ts";

export function sendActSentinel(send: Send, id: string, kind: SentinelKind, hint: string): void {
  send({
    type: "act.response",
    id,
    verdict: "no_change",
    diff: { appeared: [], removed: [], changed: [] },
    refs: [],
    sentinel: { kind, hint },
  });
}
