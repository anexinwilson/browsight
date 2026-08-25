/**
 * The contract between the service worker and the content script.
 *
 * These two run in different worlds and only ever speak through `chrome.tabs.sendMessage`, so the
 * shapes they exchange were previously declared once on each side. They drifted by hand: adding
 * `truncated` and `nextOffset` to a read meant editing both copies, and forgetting one would have
 * compiled cleanly while silently dropping the field. Declaring them once here makes that
 * impossible, in the same spirit as `@browsight/shared/protocol` for the extension-to-server bridge.
 *
 * This module holds types only, so both sides can import it without pulling in behaviour.
 */
import type { Action, ActResponse, FieldFill, ReadResponse } from "@browsight/shared";
import type { SnapshotMode } from "../perception/snapshot.ts";

/** What the service worker asks the content script to do. */
export interface ContentMessage {
  readonly kind?: "read" | "act";
  readonly mode?: SnapshotMode;
  readonly offset?: number;
  readonly query?: string;
  readonly ref?: string;
  readonly action?: Action;
  readonly value?: string;
  readonly fields?: readonly FieldFill[];
}

/**
 * The page as the content script sees it, and what one action did to it.
 *
 * Both are derived from the frames the server receives rather than restated, so a field added to the
 * protocol cannot be forgotten here. `type` and `id` belong to the bridge envelope, which the
 * service worker adds on the way out; the content script never sees them.
 */
export type ContentReadResult = Omit<ReadResponse, "type" | "id" | "sentinel">;

export type ContentActResult = Omit<ActResponse, "type" | "id">;
