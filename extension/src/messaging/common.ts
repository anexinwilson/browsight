/**
 * Shared plumbing for the bridge message handlers: the `send` signature, the content-script read
 * shape, and the small tab/origin helpers every handler needs. Kept separate so each handler module
 * stays focused on one request type.
 */
import type { BridgeMessage, Ref } from "@browsight/shared";

/** Send a frame back to the server over the bridge socket. Injected into each handler so the
 *  handlers never reach for the socket directly. */
export type Send = (msg: BridgeMessage) => void;

export interface ContentReadResult {
  readonly markdown: string;
  readonly refs: Ref[];
  readonly hasPasswordField: boolean;
}

/** The tab the user currently has in front — the only tab read/act operate on. */
export async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

/** The origin of a URL, or the raw string if it cannot be parsed. */
export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/** Inject the content script and read the page. Shared by the read path and the tab-switch path. */
export async function readTabContent(tabId: number): Promise<ContentReadResult> {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  return (await chrome.tabs.sendMessage(tabId, { kind: "read" })) as ContentReadResult;
}
