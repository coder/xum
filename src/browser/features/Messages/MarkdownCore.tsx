import React, { useMemo } from "react";
import { Streamdown } from "streamdown";
import type { Element, Root, RootContent, Text } from "hast";
import type { Pluggable, Plugin } from "unified";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkBreaks from "remark-breaks";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { harden } from "rehype-harden";
import "katex/dist/katex.min.css";
import { normalizeMarkdown } from "./MarkdownStyles";
import { repairIncompleteMarkdownTail } from "./repairIncompleteMarkdownTail";
import { markdownComponents } from "./MarkdownComponents";
import { INTERNAL_INLINE_SKILL_HREF_PREFIX, remarkInlineSkillLinks } from "./inlineSkillMarkdown";

interface MarkdownCoreProps {
  content: string;
  children?: React.ReactNode; // For cursor or other additions
  /**
   * Enable incomplete markdown parsing for streaming content.
   * When true, the remend library will attempt to "repair" unclosed markdown
   * syntax (e.g., adding closing ** for bold). This is useful during streaming
   * but can cause bugs with content like $__variable (adds trailing __).
   * Default: false for completed content, true during streaming.
   */
  parseIncompleteMarkdown?: boolean;
  /**
   * Preserve single newlines as line breaks (like GitHub-flavored markdown).
   * When true, single newlines in text become <br> elements instead of being
   * collapsed to spaces. Useful for user-authored content where newlines
   * are intentional. Default: false.
   */
  preserveLineBreaks?: boolean;
  /**
   * Render in Streamdown's static mode, i.e. without transition-deferred block updates, even
   * while repairing incomplete markdown. MarkdownCore does the repair itself in both modes.
   * Used while the transcript backfill starves React transitions.
   */
  renderSynchronously?: boolean;
  /**
   * Parse allowed raw HTML (e.g. `<details>`) as elements. Default: true. User bubbles pass
   * false so they show the text as typed: every raw HTML tag renders as literal text (#5698).
   */
  renderRawHtml?: boolean;
}

// Plugin arrays are defined at module scope to maintain stable references.
// Streamdown treats new array references as changes requiring full re-parse.
const REMARK_PLUGINS: Pluggable[] = [
  [remarkGfm, {}],
  [remarkMath, { singleDollarTextMath: false }],
  remarkInlineSkillLinks,
];

// Same as above, but with remarkBreaks to preserve single newlines as <br>.
// Used for user-authored content where newlines are intentional (e.g., user messages).
const REMARK_PLUGINS_WITH_BREAKS: Pluggable[] = [
  [remarkGfm, {}],
  remarkBreaks,
  [remarkMath, { singleDollarTextMath: false }],
  remarkInlineSkillLinks,
];

const INTERNAL_INLINE_SKILL_SANITIZE_PROTOCOL = INTERNAL_INLINE_SKILL_HREF_PREFIX.slice(0, -1);

// Schema for rehype-sanitize that allows safe HTML elements.
// Extends the default schema to support KaTeX math and collapsible sections.
const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    // MathML comes only from rehypeKatex after sanitization, never from raw HTML.
    // Collapsible sections (GitHub-style)
    "details",
    "summary",
  ],
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), INTERNAL_INLINE_SKILL_SANITIZE_PROTOCOL],
    // SECURITY AUDIT: data: must survive sanitize for rehype-harden's allowDataImages to take
    // effect (it only ever keeps data:image/ URLs on images). Without this, every data image
    // was stripped here first, which also broke relative images in Markdown artifacts, which
    // are inlined as data: URLs.
    src: [...(defaultSchema.protocols?.src ?? []), "data"],
  },
  attributes: {
    ...defaultSchema.attributes,
    // SECURITY AUDIT: Raw CSS can conceal copied text. Only semantic Markdown classes are allowed.
    // KaTeX adds its trusted classes and styles after sanitization.
    code: [["className", /^language-./, "math-inline", "math-display"]],
  },
};

interface RawHtmlNode {
  type: "raw";
  value: string;
  position?: Text["position"];
}

type MutableHastNode = Root | RootContent | RawHtmlNode;

type MutableHastParent = Element | Root | { children: MutableHastNode[] };

const RAW_HTML_TAG_NAME_PATTERN = /<\/?\s*([A-Za-z][A-Za-z0-9:-]*)\b[^>]*>/g;
// sanitizeSchema.tagNames is constructed locally above with a concrete array literal,
// so the spread/override leaves it non-optional — no `?? []` fallback needed.
const ALLOWED_RAW_HTML_TAG_NAMES = new Set(
  sanitizeSchema.tagNames.map((tagName) => tagName.toLowerCase())
);

function isRawHtmlNode(node: unknown): node is RawHtmlNode {
  const candidate = node as { type?: unknown; value?: unknown };
  return candidate.type === "raw" && typeof candidate.value === "string";
}

function isMutableHastParent(node: unknown): node is MutableHastParent {
  const candidate = node as { children?: unknown };
  return Array.isArray(candidate.children);
}

export function rawHtmlUsesOnlyAllowedTags(rawHtml: string): boolean {
  for (const match of rawHtml.matchAll(RAW_HTML_TAG_NAME_PATTERN)) {
    const tagName = match[1]?.toLowerCase();
    if (!tagName || !ALLOWED_RAW_HTML_TAG_NAMES.has(tagName)) {
      return false;
    }
  }

  return true;
}

function rawHtmlChildrenToText(
  parent: MutableHastParent,
  keepAsHtml: (rawHtml: string) => boolean
): void {
  const children = parent.children as MutableHastNode[];

  for (let idx = 0; idx < children.length; idx++) {
    const child = children[idx];

    if (isRawHtmlNode(child)) {
      if (!keepAsHtml(child.value)) {
        // Pasted errors often include JSX/component names like `<SignOutButton/>`.
        // If we let rehype parse unknown tags as HTML, sanitize strips the whole tag;
        // treating only unknown raw HTML as text keeps the transcript readable while
        // preserving supported HTML such as <details>/<summary> below.
        children[idx] = {
          type: "text",
          value: child.value,
          position: child.position,
        };
      }

      continue;
    }

    if (isMutableHastParent(child)) {
      rawHtmlChildrenToText(child, keepAsHtml);
    }
  }
}

const rehypePreserveUnknownRawHtml: Plugin<[], Root> = () => {
  return (tree) => {
    rawHtmlChildrenToText(tree, rawHtmlUsesOnlyAllowedTags);
  };
};

// User bubbles show what the user typed: every raw HTML node becomes text (#5698).
const rehypeRawHtmlAsText: Plugin<[], Root> = () => {
  return (tree) => {
    rawHtmlChildrenToText(tree, () => false);
  };
};

// Sanitization prefixes IDs. Keep generated footnote links paired with those safe IDs.
const rehypeFootnoteLinks: Plugin<[], Root> = () => (tree) => {
  const visit = (node: Root | RootContent) => {
    if (
      node.type === "element" &&
      node.tagName === "a" &&
      (node.properties.dataFootnoteRef != null || node.properties.dataFootnoteBackref != null) &&
      typeof node.properties.href === "string" &&
      node.properties.href.startsWith("#")
    ) {
      node.properties.href = "#" + defaultSchema.clobberPrefix + node.properties.href.slice(1);
    }
    if ("children" in node) node.children.forEach(visit);
  };
  visit(tree);
};

// Everything after raw HTML parsing, shared by both lists below.
const REHYPE_PLUGINS_AFTER_RAW_HTML: Pluggable[] = [
  [rehypeSanitize, sanitizeSchema], // Sanitize HTML to prevent XSS (strips dangerous elements/attributes)
  rehypeFootnoteLinks,
  [
    harden, // Additional URL filtering for links and images
    {
      // SECURITY: Treat markdown content as untrusted. We rely on rehype-harden to
      // block dangerous URL schemes (e.g. javascript:, file:, vbscript:, data: in
      // links). Data images are allowed explicitly below.
      allowedImagePrefixes: ["*", "/"],
      allowedLinkPrefixes: ["*"],
      allowedProtocols: [INTERNAL_INLINE_SKILL_HREF_PREFIX],
      // rehype-harden requires a defaultOrigin when any allowlist is provided.
      // We use a stable placeholder origin so relative URLs can be resolved.
      defaultOrigin: "https://xum.invalid",
      allowDataImages: true,
    },
  ],
  [rehypeKatex, { errorColor: "var(--color-muted-foreground)" }], // Render math
];

const REHYPE_PLUGINS: Pluggable[] = [
  rehypePreserveUnknownRawHtml,
  rehypeRaw, // Parse HTML elements first
  ...REHYPE_PLUGINS_AFTER_RAW_HTML,
];

// No rehypeRaw: no raw node is left to parse. Sanitize and harden still run.
const REHYPE_PLUGINS_RAW_HTML_AS_TEXT: Pluggable[] = [
  rehypeRawHtmlAsText,
  ...REHYPE_PLUGINS_AFTER_RAW_HTML,
];

/**
 * Core markdown rendering component that handles all markdown processing.
 * This is the single source of truth for markdown configuration.
 *
 * Memoized to prevent expensive re-parsing when content hasn't changed.
 */
export const MarkdownCore = React.memo<MarkdownCoreProps>(
  ({
    content,
    children,
    parseIncompleteMarkdown = false,
    preserveLineBreaks = false,
    renderSynchronously = false,
    renderRawHtml = true,
  }) => {
    // Memoize the normalized content to avoid recalculating on every render.
    // Repair unclosed syntax here, in the last block only, for both modes: Streamdown's own repair
    // runs remend on the whole text on every change, which stalled long live replies (#5655). The
    // static and streaming renders get the same text, so switching between them never changes it.
    const normalizedContent = useMemo(() => {
      const normalized = normalizeMarkdown(content);
      return parseIncompleteMarkdown ? repairIncompleteMarkdownTail(normalized) : normalized;
    }, [content, parseIncompleteMarkdown]);

    return (
      <>
        <Streamdown
          components={markdownComponents}
          remarkPlugins={preserveLineBreaks ? REMARK_PLUGINS_WITH_BREAKS : REMARK_PLUGINS}
          rehypePlugins={renderRawHtml ? REHYPE_PLUGINS : REHYPE_PLUGINS_RAW_HTML_AS_TEXT}
          // The text is already repaired above. In streamdown 2.0 this prop only gates its
          // whole-text remend call (MarkdownCore.test.tsx fails if an upgrade changes that).
          parseIncompleteMarkdown={false}
          // Use "static" mode for completed content to bypass useTransition() deferral.
          // After ORPC migration, async event boundaries let React deprioritize transitions indefinitely.
          mode={parseIncompleteMarkdown && !renderSynchronously ? "streaming" : "static"}
          className="space-y-2" // Reduce from default space-y-4 (16px) to space-y-2 (8px)
          controls={{ table: false, code: true, mermaid: true }} // Disable table copy/download, keep code/mermaid controls
        >
          {normalizedContent}
        </Streamdown>
        {children}
      </>
    );
  }
);

MarkdownCore.displayName = "MarkdownCore";
