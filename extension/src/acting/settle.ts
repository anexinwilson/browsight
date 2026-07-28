/**
 * Wait for the page to settle after an action: resolve once the DOM has stayed quiet for a short
 * window, or after a hard timeout, whichever comes first.
 */
export function settle(
  scope: Node = document.documentElement,
  timeoutMs = 1800,
  quietMs = 400,
  minimumMs = 150,
): Promise<void> {
  return new Promise((resolve) => {
    let quietTimer = 0;
    const startedAt = Date.now();
    const observer = new MutationObserver(() => {
      clearTimeout(quietTimer);
      scheduleFinish();
    });
    const hardTimer = setTimeout(finish, timeoutMs);
    function scheduleFinish(): void {
      const minimumRemaining = Math.max(0, minimumMs - (Date.now() - startedAt));
      quietTimer = setTimeout(finish, Math.max(quietMs, minimumRemaining));
    }
    function finish(): void {
      observer.disconnect();
      clearTimeout(quietTimer);
      clearTimeout(hardTimer);
      resolve();
    }
    observer.observe(scope, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    scheduleFinish();
  });
}
