/**
 * Display-text cleaning for strings an MCP server controls (server identity, entry point
 * titles). Shared by the node server-identity parser and the MCP Apps entry point parser.
 */

/**
 * Characters that can hide, reorder, or terminate display text: C0/C1
 * controls, line/paragraph separators, and the Unicode bidi controls.
 */
export const UNSAFE_TEXT = /[\p{Cc}\u2028\u2029\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]+/gu;

/**
 * Display-text sanitizer over a bounded raw prefix. `maxChars` is the raw
 * UTF-16 inspection budget (the unit zod's string `max` counts): the value is
 * clipped to it first, never splitting a surrogate pair (a pair straddling
 * the boundary is dropped, not halved), and only that prefix is sanitized:
 * unsafe characters become a space, whitespace runs collapse, the result is
 * trimmed. Nothing beyond the prefix is ever read, so a field whose in-budget
 * prefix normalizes to nothing yields undefined even if valid text follows,
 * and normalized text can be shorter than the budget. Replacements never
 * lengthen text, so the result always fits the limit. Returns undefined for
 * non-strings and empty results. This bounds work per field; it is not a
 * latency guarantee for MCP parsing as a whole.
 */
export function sanitizeText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  let prefix = value;
  if (value.length > maxChars) {
    const lastUnit = value.charCodeAt(maxChars - 1);
    const cut = lastUnit >= 0xd800 && lastUnit <= 0xdbff ? maxChars - 1 : maxChars;
    prefix = value.slice(0, cut);
  }
  const cleaned = prefix.replace(UNSAFE_TEXT, " ").replace(/\s+/gu, " ").trim();
  return cleaned.length > 0 ? cleaned : undefined;
}
