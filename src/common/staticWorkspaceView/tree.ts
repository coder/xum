/**
 * The element tree of one transcript row for the static workspace view (T3 #5971, Option C step 4).
 * The server renders a row's markdown with the live components (renderRowTree) and sends this
 * tree. The early script builds it with createElement and text nodes only, so it never parses
 * HTML.
 *
 * SECURITY AUDIT: the text comes from the transcript (attacker-controlled). validateStaticTree
 * keeps only the tags, attributes and classes the live markdown components emit for the supported
 * subset. Links, images, unknown inline styles and unknown classes give null,
 * so no attacker-chosen URL or CSS reaches the page. Both the server and the early script run it.
 */

/** A text node, or `[tag, attributes, ...children]`. */
export type StaticNode = string | StaticElement;
export type StaticElement = [tag: string, attributes: Record<string, string>, ...StaticNode[]];

const BLOCK = ["class", "data-streamdown"];

/** Allowed attributes per tag. A value must also pass STATIC_TREE_ATTRIBUTE_VALUES when it lists the name. */
export const STATIC_TREE_TAGS: Readonly<Record<string, readonly string[]>> = {
  div: [...BLOCK, "data-code-language", "style"],
  p: [],
  span: BLOCK,
  em: [],
  del: [],
  b: [],
  code: [],
  br: [],
  hr: BLOCK,
  ol: [...BLOCK, "start"],
  ul: BLOCK,
  li: BLOCK,
  blockquote: BLOCK,
  h1: BLOCK,
  h2: BLOCK,
  h3: BLOCK,
  h4: BLOCK,
  h5: BLOCK,
  h6: BLOCK,
  table: BLOCK,
  thead: BLOCK,
  tbody: BLOCK,
  tr: BLOCK,
  th: [...BLOCK, "style"],
  td: [...BLOCK, "style"],
  button: ["class", "aria-label"],
  svg: [
    "class",
    "xmlns",
    "viewBox",
    "fill",
    "stroke",
    "stroke-width",
    "stroke-linecap",
    "stroke-linejoin",
  ],
  rect: ["x", "y", "width", "height", "rx", "ry"],
  path: ["d"],
};

export const STATIC_TREE_ATTRIBUTE_VALUES: Readonly<Record<string, RegExp>> = {
  "data-streamdown": /^[a-z0-9-]+$/,
  "data-code-language": /^[\w+-]+$/,
  start: /^\d{1,9}$/,
  // Table alignment, and the user row's text style (UserMessageContent markdownStyles.sent).
  style:
    /^(text-align:(left|right|center)|color:var\(--color-user-text\);overflow-wrap:break-word;word-break:break-word)$/,
  "aria-label": /^Copy to clipboard$/,
};

/**
 * Every class the live components emit for the supported subset. renderRowTree.test.ts fails when
 * a component emits a class that is missing here (that row would silently get no view) and when an
 * entry here is no longer emitted.
 */
export const STATIC_TREE_CLASSES: ReadonlySet<string> = new Set(
  (
    "*:first:mt-0 *:last:mb-0 [&>p]:inline [li_&]:pl-6 bg-muted/40 bg-muted/80 border " +
    "border-b border-border border-collapse border-l-4 border-muted-foreground/30 " +
    "code-block-container code-block-single-line code-block-wrapper code-copy-button " +
    "code-line copy-button copy-icon divide-border divide-y flex flex-col font-semibold " +
    "italic line-number list-decimal list-disc list-inside markdown-content mb-2 mt-6 my-4 " +
    "my-6 overflow-x-auto pl-4 px-4 py-1 py-2 space-y-2 text-2xl text-3xl text-base " +
    "text-left text-lg text-muted-foreground text-sm text-xl user-message-markdown w-full " +
    "whitespace-normal whitespace-nowrap"
  ).split(" ")
);

/** `[tag, attributes, ...]` with an allowed tag and a plain attributes object. */
function isElementShape(node: unknown, depth: number): node is [string, object, ...unknown[]] {
  // The live markdown nests a few levels deep. A deeper tree is not ours.
  if (!Array.isArray(node) || node.length < 2 || depth > 32) return false;
  const [tag, attributes] = node as unknown[];
  if (typeof tag !== "string" || !Object.hasOwn(STATIC_TREE_TAGS, tag)) return false;
  return typeof attributes === "object" && attributes !== null && !Array.isArray(attributes);
}

function isAllowedAttribute(tag: string, name: string, value: unknown): boolean {
  if (typeof value !== "string" || !STATIC_TREE_TAGS[tag].includes(name)) return false;
  if (
    Object.hasOwn(STATIC_TREE_ATTRIBUTE_VALUES, name) &&
    !STATIC_TREE_ATTRIBUTE_VALUES[name].test(value)
  )
    return false;
  return name !== "class" || value.split(" ").every((c) => STATIC_TREE_CLASSES.has(c));
}

/** The node if every element, attribute and class is allowed, else null. */
export function validateStaticTree(node: unknown, depth = 0): StaticNode | null {
  if (typeof node === "string") return node;
  if (!isElementShape(node, depth)) return null;
  const [tag, attributes, ...children] = node;
  if (!Object.entries(attributes).every(([name, value]) => isAllowedAttribute(tag, name, value))) {
    return null;
  }
  if (!children.every((child) => validateStaticTree(child, depth + 1) !== null)) return null;
  return node as StaticElement;
}
