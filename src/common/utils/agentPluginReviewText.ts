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

export function showOneLineControls(text: string): string {
  return text.replace(ONE_LINE_CONTROLS, markControl);
}

/**
 * Unicode tag characters (U+E0020-U+E007F, plus the U+E0000 cancel tag): default-ignorables that
 * stand on their own and map one-to-one onto ASCII, so a run of them spells a message no renderer
 * shows. They are deprecated and no chat or code text holds them legitimately.
 *
 * One legitimate use exists and must survive untouched: a subdivision flag is U+1F3F4 (the black
 * flag) followed by two to five lowercase-letter/digit tags and terminated by U+E007F, e.g. the
 * England flag. Its tags ARE the emoji, so marking them would replace a rendered flag with
 * `<U+E0067><U+E0062>...` — and since copy and Edit consume the displayed text, that would also
 * corrupt what the user copies or re-sends. Listed first so the alternation consumes the whole
 * sequence before the tag branch can reach its members.
 */
const TAG_OR_SUBDIVISION_FLAG =
  /[\u{1F3F4}][\u{E0061}-\u{E007A}\u{E0030}-\u{E0039}]{2,5}[\u{E007F}]|[\u{E0000}\u{E0020}-\u{E007F}]/gu;

/** A well-formed subdivision flag (black flag + tag sequence + cancel), left as one emoji. */
const SUBDIVISION_FLAG = /[\u{1F3F4}][\u{E0061}-\u{E007A}\u{E0030}-\u{E0039}]{2,5}[\u{E007F}]/gu;

/** The black-flag base a subdivision flag's tag sequence attaches to. */
const BLACK_FLAG = String.fromCodePoint(0x1f3f4);

/**
 * Each tag character in `text` becomes its visible `<U+XXXX>` mark, leaving everything else
 * byte-identical. Needed wherever text is shown but still travels to a model provider: the tags
 * are invisible in the transcript yet provider-visible, so a smuggled instruction would be sent
 * and read by the model while the user could neither see nor copy it. Scoped to tags rather than
 * to all default-ignorables on purpose - variation selectors and joiners sit inside everyday emoji
 * and marking those would mangle ordinary text.
 */
export function revealUnicodeTags(text: string): string {
  return text.replace(TAG_OR_SUBDIVISION_FLAG, (matched) =>
    // The flag branch is the only one that can start with the black flag; every other match is a
    // single tag character, which becomes its mark.
    matched.startsWith(BLACK_FLAG) ? matched : markControl(matched)
  );
}

/**
 * Whether `text` hides an ASCII payload in tag characters. Well-formed subdivision flags are not a
 * payload: they are the England/Scotland/Wales emoji, which a renderer shows.
 */
export function containsUnicodeTags(text: string): boolean {
  return /[\u{E0000}\u{E0020}-\u{E007F}]/u.test(text.replace(SUBDIVISION_FLAG, ""));
}
