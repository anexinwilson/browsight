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

/** Strip leaked HTML tags and normalize whitespace. Accessible names/labels must be plain text —
 *  some sites put markup in alt/aria-label, which would otherwise surface as `<img …>` in a name. */
function stripMarkup(value: string): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The element's accessible name, plain-text and whitespace-normalized. */
export function safeName(el: Element): string {
  try {
    return stripMarkup(computeAccessibleName(el));
  } catch {
    return "";
  }
}

const STATE_ATTRS = [
  "aria-pressed",
  "aria-expanded",
  "aria-checked",
  "aria-selected",
  "aria-current",
  "aria-disabled",
  "aria-invalid",
];

/**
 * A compact, value-free fingerprint of an element's interactive state, used to detect that an
 * existing control changed after an action (a toggle flipped, a section expanded, a box checked).
 * Deliberately omits raw input values so a user's typed text/secrets never travel in a reference.
 */
export function elementState(el: Element): string {
  const parts: string[] = [];
  for (const attr of STATE_ATTRS) {
    const value = el.getAttribute(attr);
    if (value !== null) {
      parts.push(`${attr}=${value}`);
    }
  }
  if (el instanceof HTMLInputElement) {
    if (el.type === "checkbox" || el.type === "radio") {
      parts.push(`checked=${el.checked}`);
    } else if (el.type !== "password") {
      parts.push(el.value ? "filled" : "empty");
    }
  } else if (el instanceof HTMLTextAreaElement) {
    parts.push(el.value ? "filled" : "empty");
  } else if (el instanceof HTMLSelectElement) {
    parts.push(`selected=${el.selectedIndex}`);
  }
  return parts.join(" ");
}

/**
 * A best-effort label when the accessible name is empty, so a control is never an unidentifiable
 * `[combobox "" #n]`. Falls back to placeholder/title/aria-label, then a short slice of text
 * content. Never reads `value` (a user's typed text/secret must not become a reference label).
 */
export function fallbackName(el: Element): string {
  const attr =
    el.getAttribute("placeholder") ?? el.getAttribute("title") ?? el.getAttribute("aria-label");
  if (attr) {
    return stripMarkup(attr);
  }
  return stripMarkup(el.textContent ?? "").slice(0, 60);
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
