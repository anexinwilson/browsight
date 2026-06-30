/**
 * The content script: the only code that touches the page. Injected on demand by the service
 * worker, it answers `read` (snapshot) and `act` messages. Injection can happen more than once, so
 * listeners are registered only on the first run.
 */
import type { Action, Diff, Ref, Sentinel, Verdict } from "@browsight/shared";
import { performAct } from "./acting/act.ts";
import { rememberSnapshot } from "./acting/resolve.ts";
import { buildSnapshot } from "./perception/snapshot.ts";

interface ReadResult {
  readonly markdown: string;
  readonly refs: Ref[];
  readonly hasPasswordField: boolean;
}

interface ActResult {
  readonly verdict: Verdict;
  readonly diff: Diff;
  readonly refs: Ref[];
  readonly sentinel?: Sentinel;
}

interface ContentMessage {
  readonly kind?: string;
  readonly ref?: string;
  readonly action?: Action;
  readonly value?: string;
}

declare global {
  var __browsightInjected: boolean | undefined;
}

if (!globalThis.__browsightInjected) {
  globalThis.__browsightInjected = true;

  chrome.runtime.onMessage.addListener(
    (
      message: ContentMessage,
      _sender,
      sendResponse: (response: ReadResult | ActResult) => void,
    ) => {
      // biome-ignore lint/suspicious/noExplicitAny: used for test overrides
      const activeBuildSnapshot = (globalThis as any).__mockBuildSnapshot || buildSnapshot;
      // biome-ignore lint/suspicious/noExplicitAny: used for test overrides
      const activeRememberSnapshot = (globalThis as any).__mockRememberSnapshot || rememberSnapshot;
      // biome-ignore lint/suspicious/noExplicitAny: used for test overrides
      const activePerformAct = (globalThis as any).__mockPerformAct || performAct;

      if (message.kind === "read") {
        const snap = activeBuildSnapshot(document);
        activeRememberSnapshot(snap.refs, snap.elements);
        // Freshness marker: performance.timeOrigin is the page's load time — constant for one page
        // instance, and it changes on every reload/navigation. It reflects the PAGE load, not this
        // content script's re-injection (the same document keeps the same timeOrigin), so comparing
        // it across two reads tells the agent whether the page actually refreshed/navigated.
        const pageLoad = Math.round(performance.timeOrigin);
        sendResponse({
          markdown: `<!-- page-load:${pageLoad} (changes on reload/navigate) -->\n${snap.markdown}`,
          refs: snap.refs,
          hasPasswordField: snap.hasPasswordField,
        });
        return false;
      }
      if (message.kind === "act" && message.ref && message.action) {
        void activePerformAct(message.ref, message.action, message.value).then(sendResponse);
        return true;
      }
      return false;
    },
  );
}
