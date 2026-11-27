/**
 * Brand values: up to five short tags a seller picks to say what the brand
 * stands for ("Women owned", "Eco-friendly"). Shown on the seller's page on
 * the store. Safe to use in the browser.
 */

export const BRAND_VALUES_MAX = 5;
export const BRAND_VALUE_MAX_LENGTH = 30;

/** Offered as one-tap choices in the portal. Sellers can also type their own. */
export const SUGGESTED_BRAND_VALUES = [
  "Women owned", "Eco-friendly", "Sustainable", "Organic", "Handmade", "Small batch",
  "Fair trade", "Cruelty-free", "Vegan", "Made in India", "Recycled materials", "Plastic-free",
];

// Starts with a letter or number; then plain words (any alphabet) and a few joining marks. No links, tags or symbols.
const PLAIN = /^[\p{L}\p{N}][\p{L}\p{M}\p{N} &'’\-./+%]*$/u;

/** Splits what was typed ("Women owned, Organic") into tags, without checking them. */
export const splitBrandValues = (typed: string): string[] =>
  typed.split(/[,\n;]/).map((t) => t.trim().replace(/^#+/, "").replace(/\s+/g, " ").trim()).filter(Boolean);

const key = (t: string) => t.toLowerCase();

/** Reads the tags from a form field. Repeats (in any letter case) are dropped; the first spelling wins. */
export function cleanBrandValues(typed: string): { values: string[]; error?: string } {
  const values: string[] = [];
  for (const t of splitBrandValues(typed)) if (!values.some((v) => key(v) === key(t))) values.push(t);
  const long = values.find((v) => v.length > BRAND_VALUE_MAX_LENGTH);
  if (long) return { values: [], error: `Keep each one to ${BRAND_VALUE_MAX_LENGTH} characters or fewer. “${long.slice(0, 40)}${long.length > 40 ? "…" : ""}” is too long.` };
  const odd = values.find((v) => !PLAIN.test(v));
  if (odd) return { values: [], error: `Use plain words only, without links or symbols. Check “${odd}”.` };
  if (values.length > BRAND_VALUES_MAX) return { values: [], error: `Choose up to ${BRAND_VALUES_MAX}. You have ${values.length}.` };
  return { values };
}

/** Adds the tag if it isn't there, removes it if it is; returns the field's new text. */
export function toggleBrandValue(typed: string, tag: string): string {
  const now = splitBrandValues(typed);
  const next = now.some((v) => key(v) === key(tag)) ? now.filter((v) => key(v) !== key(tag)) : [...now, tag];
  return next.join(", ");
}
