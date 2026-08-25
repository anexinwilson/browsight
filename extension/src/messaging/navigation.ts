/**
 * Driving a tab to a new page, and knowing when it has arrived.
 *
 * A navigation is the one action whose result is a different document, so it cannot be judged by
 * diffing the page: the answer is simply whether the tab finished loading, and where it ended up.
 * Waiting on `tabs.onUpdated` rather than polling means a fast navigation returns immediately, and
 * the deadline covers the case where the page never settles.
 *
 * The destination is re-checked against the whitelist after the fact, because a URL can redirect
 * somewhere the user never allowed.
 */
import type { ActResponse } from "@browsight/shared";
import { decideAccess, type Grant } from "../permissions/policy.ts";
import { originOf, type Send } from "./common.ts";
import { withDeadline } from "./deadline.ts";
import { sendActSentinel } from "./sentinels.ts";

const NAVIGATION_TIMEOUT_MS = 8_000;

/** A navigation reports no diff: the page it described is gone. */
const NAVIGATED: Pick<ActResponse, "verdict" | "diff" | "refs"> = {
  verdict: "navigated",
  diff: { appeared: [], removed: [], changed: [] },
  refs: [],
};

function tabIsReady(tab: chrome.tabs.Tab | undefined): tab is chrome.tabs.Tab {
  return Boolean(tab && tab.status !== "loading");
}

/**
 * Start something that navigates a tab, and resolve once that tab has finished loading.
 *
 * The listener is removed in a `finally` rather than on each success path. It used to be removed
 * only when the promise settled, so a navigation that hit the deadline left its listener registered
 * for the life of the service worker, holding a closure over a promise nobody was waiting on any
 * more. Removing an already-removed listener is a no-op, so covering every exit costs nothing.
 */
async function waitForTabReady(
  tabId: number,
  start: () => Promise<chrome.tabs.Tab | undefined>,
): Promise<chrome.tabs.Tab> {
  const onUpdated = chrome.tabs.onUpdated;
  if (!onUpdated?.addListener || !onUpdated.removeListener) {
    await start();
    return chrome.tabs.get(tabId);
  }

  let listener: Parameters<typeof onUpdated.addListener>[0] | undefined;
  try {
    return await withDeadline(
      new Promise<chrome.tabs.Tab>((resolve, reject) => {
        listener = (
          updatedTabId: number,
          changeInfo: chrome.tabs.OnUpdatedInfo,
          tab: chrome.tabs.Tab,
        ): void => {
          if (updatedTabId === tabId && (changeInfo.status === "complete" || tabIsReady(tab))) {
            resolve(tab);
          }
        };
        onUpdated.addListener(listener);
        start()
          .then(async (tab) => {
            const observed = tab ?? (await chrome.tabs.get(tabId));
            if (tabIsReady(observed)) {
              resolve(observed);
            }
          })
          .catch(reject);
      }),
      "navigation",
      NAVIGATION_TIMEOUT_MS,
    );
  } finally {
    if (listener) {
      onUpdated.removeListener(listener);
    }
  }
}

export async function waitForExistingNavigation(tabId: number): Promise<chrome.tabs.Tab> {
  return waitForTabReady(tabId, () => chrome.tabs.get(tabId));
}

export async function handleNavigate(
  send: Send,
  id: string,
  value: string | undefined,
  tabId: number,
  grants: Grant[],
  now: number,
): Promise<void> {
  if (value === "reload" || value === "refresh") {
    await waitForTabReady(tabId, async () => {
      await chrome.tabs.reload(tabId);
      return undefined;
    });
    send({ type: "act.response", id, ...NAVIGATED });
    return;
  }
  if (!value) {
    sendActSentinel(send, id, "not_actionable", "navigate needs a url value (or 'reload')");
    return;
  }
  const target = originOf(value);
  if (!decideAccess(grants, target, now).act) {
    sendActSentinel(
      send,
      id,
      "not_whitelisted",
      `${target} is not set to "Full control", navigating there is an action and needs full-control access in the browsight popup.`,
    );
    return;
  }
  const destination = await waitForTabReady(tabId, () => chrome.tabs.update(tabId, { url: value }));
  const destinationOrigin = destination.url ? originOf(destination.url) : target;
  if (!decideAccess(grants, destinationOrigin, Date.now()).read) {
    sendActSentinel(
      send,
      id,
      "not_whitelisted",
      `the page navigated to ${destinationOrigin}, which is not whitelisted, allow it in the browsight popup to continue.`,
    );
    return;
  }
  send({ type: "act.response", id, ...NAVIGATED });
}
