/**
 * Storage and host-permission plumbing for the whitelist. The pure decision logic lives in
 * `policy.ts`; this module is the `chrome.*` side. Policy is kept in `chrome.storage.local`, which
 * is outside the model's reach.
 */
import type { Grant } from "./policy.ts";

const STORAGE_KEY = "browsight.grants";

/** Read the stored grants. */
export async function listGrants(): Promise<Grant[]> {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  const grants = data[STORAGE_KEY];
  return Array.isArray(grants) ? (grants as Grant[]) : [];
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
  const granted = await chrome.permissions.request({ origins: [`${grant.origin}/*`] });
  if (!granted) {
    return false;
  }
  const grants = (await listGrants()).filter((g) => g.origin !== grant.origin);
  grants.push(grant);
  await saveGrants(grants);
  return true;
}

/** Remove a grant and drop the matching host permission. */
export async function revokeSite(origin: string): Promise<void> {
  const grants = (await listGrants()).filter((g) => g.origin !== origin);
  await saveGrants(grants);
  await chrome.permissions.remove({ origins: [`${origin}/*`] });
}
