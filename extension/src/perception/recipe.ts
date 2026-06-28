/**
 * The durable, multi-attribute fingerprint used to re-resolve a reference on a changed page.
 */
import type { Recipe } from "@browsight/shared";

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
