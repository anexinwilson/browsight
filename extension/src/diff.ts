/**
 * Pure post-action helpers: the structural diff between two snapshots' references, and the typed
 * verdict. No DOM access, so these are unit-tested directly.
 */
import type { Action, Diff, Ref, Verdict } from "@browsight/shared";

function refKey(r: Ref): string {
  return `${r.role} ${JSON.stringify(r.name)}`;
}

/** Group each key's state fingerprints in document order, so persistent controls can be compared. */
function statesByKey(refs: readonly Ref[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const r of refs) {
    const key = refKey(r);
    const list = map.get(key);
    if (list) {
      list.push(r.state ?? "");
    } else {
      map.set(key, [r.state ?? ""]);
    }
  }
  return map;
}

/**
 * Compare two reference sets by role+name: which interactive elements appeared, were removed, or
 * changed interactive state (a toggle flipped, a section expanded, a box checked) while persisting.
 */
export function computeDiff(before: readonly Ref[], after: readonly Ref[]): Diff {
  const beforeStates = statesByKey(before);
  const afterStates = statesByKey(after);
  const appeared = [...afterStates.keys()].filter((k) => !beforeStates.has(k));
  const removed = [...beforeStates.keys()].filter((k) => !afterStates.has(k));
  const changed: string[] = [];
  for (const [key, aList] of afterStates) {
    const bList = beforeStates.get(key);
    if (!bList) {
      continue;
    }
    const n = Math.min(bList.length, aList.length);
    for (let i = 0; i < n; i++) {
      if (bList[i] !== aList[i]) {
        changed.push(key);
        break;
      }
    }
  }
  return { appeared, removed, changed };
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
