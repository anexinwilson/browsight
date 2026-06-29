/**
 * Storage and host-permission plumbing for the whitelist. The pure decision logic lives in
 * `policy.ts`; this module is the `chrome.*` side. Policy is kept in `chrome.storage.local`, which
 * is outside the model's reach.
 */
import type { Grant } from "./policy.ts";

const STORAGE_KEY = "browsight.grants";

/**
 * Read the stored grants, dropping any that have expired and releasing their Chrome host permission
 * so an expired "1 hour" grant never leaves the extension holding access indefinitely.
 */
export async function listGrants(): Promise<Grant[]> {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  const stored = data[STORAGE_KEY];
  const all = Array.isArray(stored) ? (stored as Grant[]) : [];
  const now = Date.now();
  const live = all.filter((g) => g.expiresAt === null || g.expiresAt > now);
  if (live.length !== all.length) {
    await saveGrants(live);
    for (const g of all) {
      if (g.expiresAt !== null && g.expiresAt <= now) {
        await chrome.permissions.remove({ origins: [`${g.origin}/*`] });
      }
    }
  }
  return live;
}

/** Persist the grants. */
export async function saveGrants(grants: Grant[]): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: grants });
}

/**
 * Add or replace a grant for an origin, requesting the matching Chrome host permission first.
 * Returns false (and saves nothing) if the user declines the browser prompt.
 */
export async function grantSite(grant: Grant): Promise<boolean> {
  // Persist the grant BEFORE requesting the host permission. Chrome's permission prompt closes the
  // popup and destroys this script context, so a save *after* the await is lost on the first click
  // (the grant only "took" on a second click, when the permission was already held and no prompt
  // appeared). Saving first means the grant survives the popup closing; roll back only on a decline.
  const others = (await listGrants()).filter((g) => g.origin !== grant.origin);
  await saveGrants([...others, grant]);
  const granted = await chrome.permissions.request({ origins: [`${grant.origin}/*`] });
  if (!granted) {
    await saveGrants(others);
    return false;
  }
  return true;
}

/** Remove a grant and drop the matching host permission. */
export async function revokeSite(origin: string): Promise<void> {
  const grants = (await listGrants()).filter((g) => g.origin !== origin);
  await saveGrants(grants);
  await chrome.permissions.remove({ origins: [`${origin}/*`] });
}
