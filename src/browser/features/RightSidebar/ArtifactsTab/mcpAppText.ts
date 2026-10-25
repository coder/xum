/**
 * Display escaping for MCP Apps text that a view or the model controls (consent prompts,
 * picker labels). Shared by McpAppFrame and mcpAppViewsStore.
 */

/** Bidi format characters, which reorder how the surrounding text displays. */
export const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
/**
 * For one-line names: bidi format characters, C0/C1 control characters and the Unicode line and
 * paragraph separators (the set mcpServerIdentity.ts treats as unsafe), which could reorder,
 * break or hide the question around the name. Backslashes too, so the escaping stays
 * unambiguous: `foo\u202e` (literal text) and `foo` + U+202E must not display alike.
 */
export const NAME_CONTROLS = /[\\\p{Cc}\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu;

/**
 * Review-only rendering: the matched characters become visible `\uXXXX` escapes (a matched
 * backslash becomes `\\`), so a view cannot make the text it asks the user to approve display
 * reordered or hidden. The request itself is unchanged.
 */
export function escapeControls(text: string, pattern: RegExp = BIDI_CONTROLS): string {
  return text.replace(pattern, (char) =>
    char === "\\" ? "\\\\" : `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
}
