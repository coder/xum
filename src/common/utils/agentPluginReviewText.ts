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

/** Tag characters of a string: U+E0000 plus each ASCII code point. */
const tagCharacters = (ascii: string): string =>
  [...ascii].map((char) => String.fromCodePoint(0xe0000 + char.charCodeAt(0))).join("");

/**
 * The only subdivision flags Unicode defines (CLDR RGI): England, Scotland, Wales. Exposed as a
 * pattern source so the transcript and the plugin-name guard cannot disagree about which tag
 * sequences a font actually draws -- any other sequence renders as a plain black flag, so its tags
 * are a hidden payload rather than an emoji.
 */
export const RGI_SUBDIVISION_FLAG_PATTERN = `\u{1f3f4}(?:${["gbeng", "gbsct", "gbwls"]
  .map(tagCharacters)
  .join("|")})\u{e007f}`;

/**
 * Unicode tag characters (U+E0020-U+E007F, plus the U+E0000 cancel tag and the U+E0001 language tag:
 * the three tag-space characters outside the ASCII-mapping range): default-ignorables that stand on
 * their own and, for the U+E0020-U+E007F members, map one-to-one onto ASCII, so a run of them spells
 * a message no renderer shows. They are deprecated and no chat or code text holds them legitimately.
 *
 * U+E0001 matters even though it maps to nothing: it is the language tag's lead character, so it is
 * exactly what a smuggled `U+E0001 U+E0065 U+E006E` "en" block starts with. Left out of the class it
 * would stay invisible and default-ignorable while its payload became visible, drawing a row that is
 * neither blank nor fully explained.
 *
 * The one legitimate use is an RGI subdivision flag, whose tags ARE the emoji. Marking those would
 * replace a rendered flag with `<U+E0067>...` for no gain: the sequence already draws, so it is not
 * a hidden payload. The flag branch is listed first so the alternation consumes the whole flag
 * before the tag branch can reach its members. Any other tag sequence -- `usca`, say -- is not a
 * flag any font draws, so it stays a payload and is revealed.
 */
const TAG_OR_RGI_SUBDIVISION_FLAG = new RegExp(
  `(${RGI_SUBDIVISION_FLAG_PATTERN})|[\u{E0000}\u{E0001}\u{E0020}-\u{E007F}]`,
  "gu"
);

/** The black-flag base an RGI subdivision flag's tag sequence attaches to. */
const BLACK_FLAG = String.fromCodePoint(0x1f3f4);

/**
 * Each tag character in `text` becomes its visible `<U+XXXX>` mark, leaving everything else
 * byte-identical. Needed wherever text is shown but still travels to a model provider: the tags
 * are invisible in the transcript yet provider-visible, so a smuggled instruction would be sent
 * and read by the model while the user could neither see nor copy it.
 *
 * Scoped to tags rather than to all default-ignorables on purpose - variation selectors and joiners
 * sit inside everyday emoji and marking those would mangle ordinary text. And call it only at the
 * point where text becomes pixels: the mark is irreversible, so revealing text that Copy, an editor
 * draft or a provider request still reads would substitute 8 ASCII characters per invisible one and
 * persist them as if the user had typed that.
 */
export function revealUnicodeTags(text: string): string {
  return text.replace(TAG_OR_RGI_SUBDIVISION_FLAG, (matched) =>
    // Only the RGI-flag branch can start with the black flag; every other match is a single tag.
    matched.startsWith(BLACK_FLAG) ? matched : markControl(matched)
  );
}

/**
 * Whether `text` hides an ASCII payload in tag characters. RGI subdivision flags are not a payload:
 * they are the England/Scotland/Wales emoji, which a font draws.
 */
export function containsUnicodeTags(text: string): boolean {
  return new RegExp("[\u{E0000}\u{E0001}\u{E0020}-\u{E007F}]", "u").test(
    text.replace(new RegExp(RGI_SUBDIVISION_FLAG_PATTERN, "gu"), "")
  );
}
