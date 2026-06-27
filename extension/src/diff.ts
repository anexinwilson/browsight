/**
 * Pure post-action helpers: the structural diff between two snapshots' references, and the typed
 * verdict. No DOM access, so these are unit-tested directly.
 */
import type { Action, Diff, Ref, Verdict } from "@browsight/shared";

function refKey(r: Ref): string {
  return `${r.role} ${JSON.stringify(r.name)}`;
}

/** Compare two reference sets by role+name, reporting which interactive elements appeared/removed. */
export function computeDiff(before: readonly Ref[], after: readonly Ref[]): Diff {
  const beforeKeys = new Set(before.map(refKey));
  const afterKeys = new Set(after.map(refKey));
  return {
    appeared: [...afterKeys].filter((k) => !beforeKeys.has(k)),
    removed: [...beforeKeys].filter((k) => !afterKeys.has(k)),
    changed: [],
  };
}

/** Classify what an action did, from the before/after snapshots and whether a fill stuck. */
export function selectVerdict(
  action: Action,
  beforeMarkdown: string,
  afterMarkdown: string,
  valueSet: boolean,
): Verdict {
  if (action === "fill" && valueSet) {
    return "value_set";
  }
  if (action === "navigate") {
    return "navigated";
  }
  return beforeMarkdown === afterMarkdown ? "no_change" : "dom_changed";
}
