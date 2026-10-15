import type { Element, Root } from "hast";
import type { Pluggable, Plugin } from "unified";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";

const MATH_CLASSES = new Set(["language-math", "math-inline", "math-display"]);

// Streamdown memoizes its elements (p, li, strong, ...) on className and source position, so when
// KaTeX arrives a paragraph would keep its plain math. A marker class on each ancestor of a math
// node re-renders that path only. React keeps the DOM nodes, so the browser's scroll anchor holds.
const rehypeMarkMathAncestors: Plugin<[], Root> = () => (tree) => {
  const classes = (node: Element) =>
    Array.isArray(node.properties.className) ? node.properties.className : [];
  const visit = (node: Root | Element): boolean => {
    let hasMath = false;
    for (const child of node.children) {
      if (child.type !== "element") continue;
      if (visit(child) || classes(child).some((name) => MATH_CLASSES.has(String(name)))) {
        hasMath = true;
      }
    }
    if (hasMath && node.type === "element")
      node.properties.className = [...classes(node), "katex-host"];
    return hasMath;
  };
  visit(tree);
};

/**
 * Loaded only once a message contains math (T3, #5971). Vite resolves the import after this
 * chunk's CSS has loaded, so math never shows unstyled. MarkdownCore appends these last, after
 * sanitize and harden, as before the split: KaTeX adds its own trusted classes and styles.
 */ export const katexRehypePlugins: Pluggable[] = [
  rehypeMarkMathAncestors,
  [rehypeKatex, { errorColor: "var(--color-muted-foreground)" }],
];
