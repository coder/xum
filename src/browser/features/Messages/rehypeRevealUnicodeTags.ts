import type { Element, Root, RootContent } from "hast";
import type { Plugin } from "unified";
import { revealUnicodeTags } from "@/common/utils/agentPluginReviewText";

/**
 * Where a mark must not be written into drawn text: a `code` element's text is the very string its
 * Copy button hands to the clipboard (MarkdownComponents.CodeBlock), so a mark placed on it would be
 * copied as if the user had typed it; that component reveals its own drawn lines instead, keeping the
 * action's bytes raw. `pre` is deliberately not in this list: a fenced block's `pre` only ever wraps
 * such a `code` element, but raw HTML written by the model ("<pre>…</pre>", rendered because assistant
 * markdown allows it) draws its own direct text through no component at all, and skipping the whole
 * subtree there would hide a payload the provider received. `svg` is a renderer's own output — a
 * diagram reveals its labels itself (Mermaid.revealTagsInRenderedDiagram), and math is handled by
 * rehypeRevealRenderedMath below.
 */
function isOpaqueToReveal(node: Element): boolean {
  return node.tagName === "code" || node.tagName === "svg";
}

/**
 * Element properties the sanitizer accepts that are drawn or announced as text. An attribute value is
 * a second place the same bytes can hide: an image's alt text is what a screen reader reads and what
 * a broken image paints as its fallback label, and it never appears as a text node.
 */
const REVEALED_TEXT_PROPERTIES = [
  "alt",
  "title",
  "abbr",
  "ariaLabel",
  "ariaLabelledBy",
  "ariaDescribedBy",
];

function revealTextProperties(node: Element): void {
  for (const name of REVEALED_TEXT_PROPERTIES) {
    const value = node.properties[name];
    if (typeof value === "string") node.properties[name] = revealUnicodeTags(value);
  }
}

/**
 * Unicode tag characters are default-ignorables that map one-to-one onto ASCII, so a run of them
 * spells a message the model received and no renderer shows. At this point the markdown has been
 * parsed and sanitized, so replacing them in text nodes cannot change any markdown structure, and
 * every surface that draws through this pipeline (live rows, the static first paint, hover cards)
 * reveals by construction rather than by each caller remembering to. Callers pass raw bytes: the
 * mark is irreversible, so text still read by Copy, an editor draft or a provider request must never
 * be revealed upstream, and actions inside this tree read the raw text node value.
 *
 * Nothing that copies out of the rendered transcript reads these properties either: image elements are
 * in the clipboard's excluded selector (transcriptContextMenu.CLIPBOARD_EXCLUDED_SELECTOR), so an alt
 * value marked here cannot reach a copy.
 */
export const rehypeRevealUnicodeTags: Plugin<[], Root> = () => {
  return (tree) => {
    const visit = (node: Root | RootContent): void => {
      if (node.type === "text") {
        node.value = revealUnicodeTags(node.value);
        return;
      }
      if (node.type === "element") {
        if (isOpaqueToReveal(node)) return;
        revealTextProperties(node);
      }
      if ("children" in node) node.children.forEach(visit);
    };
    visit(tree);
  };
};

/** Whether this element is markup that exists only to show a formula. */
function isRenderedMath(node: Element): boolean {
  return (
    node.tagName === "math" ||
    (Array.isArray(node.properties.className) &&
      node.properties.className.some((name) => String(name) === "katex"))
  );
}

/**
 * The same reveal applied to what KaTeX typeset, so it must run after rehype-katex. The pass above
 * cannot do it: math reaches KaTeX as a math-inline/math-display/language-math code element, which
 * that pass leaves raw, so a tag payload inside `$$…$$` would be typeset as invisible glyphs.
 * Revealing the rendered markup rather than the TeX keeps KaTeX's parsing of the source untouched
 * (a mark is `<U+XXXX>`, which TeX would reject), and MathML's `<annotation>` keeps the source bytes
 * — the transcript's copy-as-Markdown reads that annotation to rebuild a `$$…$$` formula, and pasting
 * marks back as TeX would not round-trip.
 */
export const rehypeRevealRenderedMath: Plugin<[], Root> = () => {
  return (tree) => {
    /** What KaTeX emitted: every text node marked, except the MathML node that carries its source. */
    const revealRendered = (node: Root | RootContent): void => {
      if (node.type === "text") {
        node.value = revealUnicodeTags(node.value);
        return;
      }
      if (node.type === "element" && node.tagName === "annotation") return;
      if ("children" in node) node.children.forEach(revealRendered);
    };
    const visit = (node: Root | RootContent): void => {
      if (node.type === "element" && isRenderedMath(node)) {
        revealRendered(node);
        return;
      }
      if ("children" in node) node.children.forEach(visit);
    };
    visit(tree);
  };
};
