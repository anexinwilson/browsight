/**
 * The content script: the only code that touches the page. Injected on demand by the service
 * worker, it answers `read` (and later `act`) messages with a snapshot. Injection can happen more
 * than once, so listeners are registered only on the first run.
 */
import type { Ref } from "@browsight/shared";
import { buildSnapshot } from "./snapshot.ts";

interface ReadResult {
  readonly markdown: string;
  readonly refs: Ref[];
  readonly hasPasswordField: boolean;
}

interface ContentMessage {
  readonly kind?: string;
}

declare global {
  interface Window {
    __browsightInjected?: boolean;
  }
}

if (!window.__browsightInjected) {
  window.__browsightInjected = true;

  chrome.runtime.onMessage.addListener(
    (message: ContentMessage, _sender, sendResponse: (response: ReadResult) => void) => {
      if (message.kind === "read") {
        const snap = buildSnapshot(document);
        sendResponse({
          markdown: snap.markdown,
          refs: snap.refs,
          hasPasswordField: snap.hasPasswordField,
        });
      }
      return false;
    },
  );
}
