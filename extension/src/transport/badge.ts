/**
 * The toolbar badge, the only thing the user sees when browsight goes dormant. Every call is
 * guarded because the action API is absent in tests and in some extension contexts.
 */

export async function setSleepBadge(): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.action) {
    return;
  }
  try {
    if (chrome.action.setBadgeText) {
      await chrome.action.setBadgeText({ text: "ZZZ" });
    }
    if (chrome.action.setBadgeBackgroundColor) {
      await chrome.action.setBadgeBackgroundColor({ color: "#6c757d" });
    }
  } catch {
    // The action API is unavailable in this context; the badge is cosmetic, so carry on.
  }
}

export async function clearBadge(): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.action?.setBadgeText) {
    return;
  }
  try {
    await chrome.action.setBadgeText({ text: "" });
  } catch {
    // Same as above: a badge that will not clear must not break the connection path.
  }
}
