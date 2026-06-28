import type { Recipe } from "@browsight/shared";
/**
 * In-page DOM helpers used by the snapshot builder: role and accessible-name resolution (via
 * `dom-accessibility-api`), visibility, and the durable reference recipe.
 */
import { computeAccessibleName, getRole } from "dom-accessibility-api";

export const INTERACTIVE_SELECTOR =
  "a[href],button,input,select,textarea,[role],[tabindex],[contenteditable='true'],[contenteditable='']";

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

/** The element's ARIA role (explicit or implicit), or "" if it cannot be resolved. */
export function safeRole(el: Element): string {
  try {
    return getRole(el) ?? "";
  } catch {
    return "";
  }
}

/** The element's accessible name, whitespace-normalized. */
export function safeName(el: Element): string {
  try {
    return computeAccessibleName(el).replace(/\s+/g, " ").trim();
  } catch {
    return "";
  }
}

// Natively-interactive elements. Deliberately NOT bare `[role]` / `[tabindex]`: those match
// landmark/container elements (role="main", tabindex="-1") whose subtree must be walked, not skipped.
const NATIVE_INTERACTIVE =
  "a[href],button,input,select,textarea,[contenteditable='true'],[contenteditable='']";

/** True if the element is something the agent can act on (not a mere container/landmark). */
export function isInteractive(el: Element): boolean {
  if (ACTIONABLE_ROLES.has(safeRole(el))) {
    return true;
  }
  return el.matches(NATIVE_INTERACTIVE);
}

/** Build the durable recipe used to re-resolve a reference at act time. */
export function makeRecipe(el: Element, role: string, name: string, ordinal: number): Recipe {
  const dataAttrs: Record<string, string> = {};
  for (const attr of Array.from(el.attributes)) {
    if (attr.name.startsWith("data-")) {
      dataAttrs[attr.name] = attr.value;
    }
  }
  const text = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  return {
    role,
    name,
    dataAttrs,
    text,
    ordinal,
    ...(el.id ? { ancestorPath: `#${el.id}` } : {}),
  };
}
