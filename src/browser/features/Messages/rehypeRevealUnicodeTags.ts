import type { Element, Root, RootContent } from "hast";
import type { Plugin } from "unified";
import { revealUnicodeTags } from "@/common/utils/agentPluginReviewText";

/**
 * Where a mark must not be written into drawn text: fenced and inline code are drawn from the very
 * string their Copy button hands to the clipboard (MarkdownComponents.CodeBlock), so a mark placed
 * on that text would be copied as if the user had typed it. That component reveals its own drawn
 * lines instead, keeping the action's bytes raw. `svg` is a renderer's own output — a diagram
 * reveals its labels itself (Mermaid.revealTagsInRenderedDiagram), and math is handled by
 * rehypeRevealRenderedMath below.
 */
function isOpaqueToReveal(node: Element): boolean {
  return node.tagName === "code" || node.tagName === "pre" || node.tagName === "svg";
}

/**
 * Unicode tag characters are default-ignorables that map one-to-one onto ASCII, so a run of them
 * spells a message the model received and no renderer shows. At this point the markdown has been
 * parsed and sanitized, so replacing them in text nodes cannot change any markdown structure, and
 * every surface that draws through this pipeline (live rows, the static first paint, hover cards)
 * reveals by construction rather than by each caller remembering to. Callers pass raw bytes: the
 * mark is irreversible, so text still read by Copy, an editor draft or a provider request must never
 * be revealed upstream, and actions inside this tree read the raw text node value.
 */
export const rehypeRevealUnicodeTags: Plugin<[], Root> = () => {
  return (tree) => {
    const visit = (node: Root | RootContent): void => {
      if (node.type === "text") {
        node.value = revealUnicodeTags(node.value);
        return;
      }
      if (node.type === "element" && isOpaqueToReveal(node)) return;
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
    const visit = (node: Root | RootContent, insideMath: boolean): void => {
      if (node.type === "text") {
        if (insideMath) node.value = revealUnicodeTags(node.value);
        return;
      }
      if (node.type === "element" && insideMath && node.tagName === "annotation") return;
      const next = insideMath || (node.type === "element" && isRenderedMath(node));
      if ("children" in node) node.children.forEach((child) => visit(child, next));
    };
    visit(tree, false);
  };
};
