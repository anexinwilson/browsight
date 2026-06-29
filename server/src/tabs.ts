/**
 * Render the open-tabs list for the `browser_tabs` tool. Pure (no bridge access) so it is unit-tested
 * directly. The active tab is marked, and each tab's access tier is spelled out so the agent knows
 * which it can switch to and which need whitelisting first.
 */
import type { TabInfo } from "@browsight/shared";

const ACCESS_LABEL: Record<TabInfo["access"], string> = {
  full: "full control",
  read: "read-only",
  none: "not allowed — whitelist to use",
};

export function formatTabs(tabs: readonly TabInfo[]): string {
  if (tabs.length === 0) {
    return "No open http(s) tabs.";
  }
  const lines = tabs.map(
    (t) =>
      `${t.active ? "* " : "- "}${t.title || t.origin} — ${t.origin} (${ACCESS_LABEL[t.access]})`,
  );
  return `Open tabs (* = active):\n${lines.join("\n")}`;
}
