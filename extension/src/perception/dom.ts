/**
 * Element-level queries used by the snapshot walk and act-time re-resolution: whether an element is
 * rendered, and whether it is an actionable control (a button/link/field) rather than a mere
 * container or landmark.
 */
import { safeRole } from "./accessibility.ts";

export const INTERACTIVE_SELECTOR =
  "a[href],button,input,select,textarea,[role],[tabindex],[contenteditable='true'],[contenteditable='']";

// Natively-interactive elements. Deliberately NOT bare `[role]` / `[tabindex]`: those match
// landmark/container elements (role="main", tabindex="-1") whose subtree must be walked, not skipped.
const NATIVE_INTERACTIVE =
  "a[href],button,input,select,textarea,[contenteditable='true'],[contenteditable='']";

const ACTIONABLE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "menuitem",
  "tab",
  "switch",
  "slider",
  "spinbutton",
]);

/** True if the element is not rendered (hidden attribute, no box, or hidden by CSS). */
export function isHidden(el: Element): boolean {
  if (el.hasAttribute("hidden")) {
    return true;
  }
  const view = el.ownerDocument.defaultView;
  const style = view?.getComputedStyle(el);
  if (style && (style.display === "none" || style.visibility === "hidden")) {
    return true;
  }
  // `display: contents` elements generate no box of their own (a 0×0 rect) but their children DO
  // render — so the zero-size check below must not treat them, or their subtree, as hidden.
  if (style?.display === "contents") {
    return false;
  }
  const rect = (el as HTMLElement).getBoundingClientRect?.();
  return rect ? rect.width === 0 && rect.height === 0 : false;
}

/** True if the element is something the agent can act on (not a mere container/landmark). */
export function isInteractive(el: Element): boolean {
  if (ACTIONABLE_ROLES.has(safeRole(el))) {
    return true;
  }
  return el.matches(NATIVE_INTERACTIVE);
}
