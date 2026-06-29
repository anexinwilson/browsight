/**
 * Pure helpers for the tab-switching handler: turning an access decision into the wire label, and
 * resolving a user's free-text selector to the open tabs it matches. No `chrome.*` access, so these
 * are unit-tested directly.
 */
import type { Sentinel } from "@browsight/shared";
import { type Access, type Grant, decideAccess } from "../permissions/policy.ts";

export interface TabCandidate {
  readonly id: number;
  readonly title: string;
  readonly origin: string;
}

export type AccessLabel = "none" | "read" | "full";

/** Collapse an access decision into the label sent to the agent. */
export function accessLabel(access: Access): AccessLabel {
  if (access.act) {
    return "full";
  }
  return access.read ? "read" : "none";
}

/**
 * Resolve a selector to the tabs it matches: an exact tab id wins outright; otherwise a
 * case-insensitive substring of the title or origin. Every match is returned so the caller can
 * decide (none → not found, one → switch, many → ask the agent to narrow it).
 */
export function selectTabs(tabs: readonly TabCandidate[], select: string): TabCandidate[] {
  const q = select.trim().toLowerCase();
  if (!q) {
    return [];
  }
  const byId = tabs.filter((t) => String(t.id) === q);
  if (byId.length > 0) {
    return byId;
  }
  return tabs.filter(
    (t) => t.title.toLowerCase().includes(q) || t.origin.toLowerCase().includes(q),
  );
}

export type TabResolution =
  | { readonly kind: "switch"; readonly tab: TabCandidate }
  | { readonly kind: "sentinel"; readonly sentinel: Sentinel };

/**
 * Decide what a tab selector resolves to, enforcing the whitelist: it must match exactly one open
 * tab, AND that tab's origin must be readable (whitelisted, unexpired) before a switch is allowed —
 * otherwise a `not_whitelisted` sentinel is returned and no switch happens. Pure (the access check is
 * the same `decideAccess` used everywhere else), so this enforcement is unit-tested without chrome.*.
 */
export function resolveTabSelection(
  tabs: readonly TabCandidate[],
  grants: readonly Grant[],
  select: string,
  now: number,
): TabResolution {
  const matches = selectTabs(tabs, select);
  const [target, ...rest] = matches;
  if (!target) {
    return {
      kind: "sentinel",
      sentinel: {
        kind: "ambiguous_target",
        hint: `no open tab matches "${select}" — call browser_tabs with no argument to see the list.`,
      },
    };
  }
  if (rest.length > 0) {
    return {
      kind: "sentinel",
      sentinel: {
        kind: "ambiguous_target",
        hint: `"${select}" matches ${matches.length} tabs — narrow it with an exact title or origin.`,
      },
    };
  }
  if (!decideAccess(grants, target.origin, now).read) {
    return {
      kind: "sentinel",
      sentinel: {
        kind: "not_whitelisted",
        hint: `the "${target.title}" tab (${target.origin}) is not whitelisted — open the browsight popup on it and allow the site, then try again.`,
      },
    };
  }
  return { kind: "switch", tab: target };
}
