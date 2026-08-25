/**
 * Small DOM helpers shared by the extension's two pages, the popup and the options page.
 *
 * Both are plain HTML documents driven by a script, and both need the same lookup. Keeping one copy
 * means a change to how a missing element is reported happens once rather than in two files that
 * happen to look alike today.
 */
import { TIMER_OPTIONS } from "../permissions/policy.ts";

/** Find a required element by id, failing loudly rather than returning null into the caller. */
export function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) {
    throw new Error(`missing #${id}`);
  }
  return node as T;
}

/**
 * Fill the access-duration dropdown both pages offer. The list itself lives with the permission
 * policy; rendering it lived in two files that had to be kept in step by hand.
 */
export function renderTimerOptions(select: HTMLSelectElement): void {
  for (const option of TIMER_OPTIONS) {
    const node = document.createElement("option");
    node.value = String(option.ms);
    node.textContent = option.label;
    select.append(node);
  }
}
