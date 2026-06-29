/**
 * Accessible role, name, and interactive state of a DOM element, via `dom-accessibility-api`.
 * Names are sanitized to plain text so markup leaked into alt/aria-label never surfaces in a
 * reference.
 */
import { computeAccessibleName, getRole } from "dom-accessibility-api";

/** Strip leaked HTML tags and normalize whitespace. Accessible names/labels must be plain text —
 *  some sites put markup in alt/aria-label, which would otherwise surface as `<img …>` in a name. */
function stripMarkup(value: string): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/[ \t\n\r]+/g, " ")
    .trim();
}

/** The element's ARIA role (explicit or implicit), or "" if it cannot be resolved. */
export function safeRole(el: Element): string {
  try {
    return getRole(el) ?? "";
  } catch {
    return "";
  }
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
