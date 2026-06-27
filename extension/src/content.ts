/**
 * The content script: the only code that touches the page. Injected on demand by the service
 * worker, it answers `read` (snapshot) and `act` messages. Injection can happen more than once, so
 * listeners are registered only on the first run.
 */
import type { Action, Diff, Ref, Sentinel, Verdict } from "@browsight/shared";
import { performAct, rememberSnapshot } from "./act.ts";
import { buildSnapshot } from "./snapshot.ts";

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
  interface Window {
    __browsightInjected?: boolean;
  }
}

if (!window.__browsightInjected) {
  window.__browsightInjected = true;

  chrome.runtime.onMessage.addListener(
    (
      message: ContentMessage,
      _sender,
      sendResponse: (response: ReadResult | ActResult) => void,
    ) => {
      if (message.kind === "read") {
        const snap = buildSnapshot(document);
        rememberSnapshot(snap.refs, snap.elements);
        sendResponse({
          markdown: snap.markdown,
          refs: snap.refs,
          hasPasswordField: snap.hasPasswordField,
        });
        return false;
      }
      if (message.kind === "act" && message.ref && message.action) {
        void performAct(message.ref, message.action, message.value).then(sendResponse);
        return true;
      }
      return false;
    },
  );
}
