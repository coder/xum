import { containsUnicodeTags } from "@/common/utils/agentPluginReviewText";

/**
 * Whether `text` is worth a transcript row: at least one character a renderer can paint, or a Unicode
 * tag payload the model received.
 *
 * An interrupted or stalled stream can persist a delta of only a newline, which is truthy but paints
 * nothing — it still becomes a message block (`mt-4` + `py-1`), i.e. a blank line above whatever
 * follows, most visibly above a failed tool call whose row auto-expands and draws the eye.
 *
 * `trim()` alone is not enough: it leaves default-ignorables (U+200B zero-width space, U+2060 word
 * joiner, U+FEFF) intact, and those paint nothing either, so the gap would survive. Control characters
 * are in for the same reason — a persisted U+0007 (BEL) is neither whitespace nor default-ignorables
 * but draws no glyph, and the review-text guard already classifies them as invisible. Same class
 * family as `agentPluginReviewText.ts`. NBSP is `\s` to `trim`, so it needs no extra branch. U+2800
 * BRAILLE PATTERN BLANK is in as well: it is braille's SPACE, so it is a letter-like character that
 * none of the three classes covers, yet a part made only of them paints an empty run of cells
 * (`UNSAFE_TEXT` in openaiExtension already lists it as rendering blank). A braille passage with real
 * cells in it is not blank-only and keeps its row.
 *
 * Unicode MARKS are deliberately NOT in here. `\p{M}` looks like the invisible-without-a-base class,
 * but it also covers spacing marks (`General_Category=Mc`, e.g. U+0903 DEVANAGARI SIGN VISARGA) and
 * enclosing marks (Me), which are legitimate standalone output in linguistic or Unicode text; a
 * predicate that swallowed them would silently delete a rendered row instead of an empty one. Attached
 * marks are safe without any help from this predicate — the row builder joins a mark to its base
 * before a text part is ever tested, so the base carries the row.
 *
 * Unicode TAG characters are the one unpaintable class that must NOT be dropped: they are
 * default-ignorables, so they paint nothing, yet they map onto ASCII and the provider request path
 * keeps them (`dropEmptyText` is `trim()`-based, and OpenAI/Google skip that filter entirely).
 * Deleting such a row would hide instructions the model still received — the transcript would show
 * nothing where the provider saw a payload. Those rows stay, and the render leaves reveal their tags
 * as visible marks; the provider path is left to its own filter.
 *
 * The provider request path drops whitespace-only parts too (`dropEmptyText` in modelMessageTransform);
 * the transcript must not render a gap the model never saw.
 *
 * This lives in common because the same row is drawn twice: by the live transcript, and by the static
 * first view `xum server` paints before the app JS loads (workspaceViewTail). A predicate only one of
 * the two uses shows a blank row pre-hydration and loses it when the app takes over the transcript.
 */
const NO_PAINTABLE_CONTENT = /^[\s\p{Default_Ignorable_Code_Point}\p{Cc}\u2800]*$/u;

export function isPaintableText(text: string): boolean {
  return !NO_PAINTABLE_CONTENT.test(text) || containsUnicodeTags(text);
}
