/**
 * Wait for the page to settle after an action: resolve once the DOM has stayed quiet for a short
 * window, or after a hard timeout, whichever comes first.
 */
export function settle(timeoutMs = 1200, quietMs = 250): Promise<void> {
  return new Promise((resolve) => {
    let quietTimer = 0;
    const observer = new MutationObserver(() => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(finish, quietMs);
    });
    const hardTimer = setTimeout(finish, timeoutMs);
    function finish(): void {
      observer.disconnect();
      clearTimeout(quietTimer);
      clearTimeout(hardTimer);
      resolve();
    }
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
    });
    quietTimer = setTimeout(finish, quietMs);
  });
}
