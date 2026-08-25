/**
 * Shared plumbing for the bridge message handlers: the `send` signature, the content-script read
 * shape, and the small tab/origin helpers every handler needs. Kept separate so each handler module
 * stays focused on one request type.
 */
import type { BridgeMessage } from "@browsight/shared";
import type { ContentMessage, ContentReadResult } from "./content-protocol.ts";

export type { ContentReadResult };

/** Send a frame back to the server over the bridge socket. Injected into each handler so the
 *  handlers never reach for the socket directly. */
export type Send = (msg: BridgeMessage) => void;

/** How much of a page to read: which region, where to resume, and what to search for. */
export interface ReadOptions {
  readonly mode: "full" | "main";
  readonly offset: number;
  readonly query: string | null;
}

export const DEFAULT_READ: ReadOptions = { mode: "full", offset: 0, query: null };

const CURRENT_TAB_KEY = "browsight.currentTab";

/** The tab the user has in front, in the last-focused window. */
export async function focusedTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

/**
 * Record the tab browsight is operating on, so a later act targets the same tab the read or switch
 * chose. Without this, read and act each re-derive the "active" tab independently, which is
 * unreliable when tabs span multiple windows, because the last-focused window can change between the
 * two calls and send the act to a different tab than the one that was read.
 */
export async function setCurrentTab(tabId: number): Promise<void> {
  await chrome.storage.session.set({ [CURRENT_TAB_KEY]: tabId });
}

/** The tab read/act operate on: the one the last read or tab-switch recorded (if still open), else
 *  the focused tab. */
export async function currentTab(): Promise<chrome.tabs.Tab | undefined> {
  const data = await chrome.storage.session.get(CURRENT_TAB_KEY);
  const id = data[CURRENT_TAB_KEY] as number | undefined;
  if (typeof id === "number") {
    const tab = await chrome.tabs.get(id).catch(() => undefined);
    return tab ?? focusedTab();
  }
  return focusedTab();
}

/** The origin of a URL, or the raw string if it cannot be parsed. */
export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/** Inject the content script and read the page. Shared by the read path and the tab-switch path. The
 *  content script keeps the read's references in the page itself, so the act re-resolves them there. */
export async function readTabContent(
  tabId: number,
  options: ReadOptions = DEFAULT_READ,
): Promise<ContentReadResult> {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  const request: ContentMessage = {
    kind: "read",
    mode: options.mode,
    offset: options.offset,
    query: options.query ?? "",
  };
  return (await chrome.tabs.sendMessage(tabId, request)) as ContentReadResult;
}
