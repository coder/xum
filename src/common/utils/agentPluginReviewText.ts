/**
 * Characters that render invisibly, reorder text or break lines unseen (#6629): every Unicode
 * default-ignorable code point (zero-width and joiner characters, variation selectors such as
 * U+FE0F, U+034F, tags), the bidi controls, every control character except tab and LF, a CR not
 * followed by LF, and U+2028/U+2029. Several are valid in JavaScript identifiers, so without a
 * mark `safe` and `safe` + U+FE0F look the same. A lone CR, U+2028 and U+2029 end a `//` comment
 * in JavaScript, but the browser draws them as nothing or a space, so code after one would read
 * as comment text in the review while the fingerprint approves it.
 */
const REVIEW_TEXT_CONTROLS =
  /[\p{Default_Ignorable_Code_Point}\u061c\u202a-\u202e\u2066-\u2069\u2028\u2029]|\r(?!\n)|(?![\t\n\r])\p{Cc}/gu;

/**
 * The same characters plus tab, LF and CR: a one-line value (a file path, a link target) never
 * holds them legitimately, and a newline in a path could draw a second, fake review row.
 */
const ONE_LINE_CONTROLS =
  /[\p{Default_Ignorable_Code_Point}\u061c\u202a-\u202e\u2066-\u2069\u2028\u2029]|\p{Cc}/gu;

function markControl(char: string): string {
  return `<U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}>`;
}

/**
 * Review text as the user reads it: each such character becomes a visible `<U+XXXX>` mark. The
 * mark is not a JavaScript escape, so a literal `\u202e` in the source still reads differently
 * from the character itself.
 */
export function showInvisibleControls(text: string): string {
  return text.replace(REVIEW_TEXT_CONTROLS, markControl);
}

/** A one-line value (a path, a link target) as the review shows it: every control is marked. */
export function showOneLineControls(text: string): string {
  return text.replace(ONE_LINE_CONTROLS, markControl);
}
