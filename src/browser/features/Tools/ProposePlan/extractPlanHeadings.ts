import { rawHtmlUsesOnlyAllowedTags } from "@/browser/features/Messages/MarkdownCore";
import MarkdownIt from "markdown-it";

/**
 * A heading entry extracted from a plan's markdown source.
 *
 * `renderIndex` is the position of this heading among ALL h1..h6 elements
 * Streamdown will render for the same content. We use it to look up the matching
 * DOM node via `container.querySelectorAll("h1,h2,h3,h4,h5,h6")[renderIndex]`.
 * Keeping the index aligned to the rendered DOM (rather than slug IDs) avoids
 * mutating the shared markdown rehype pipeline just for plan TOC scrolling.
 */
export interface PlanHeading {
  renderIndex: number;
  /** 1-6, matching the rendered hN tag. */
  level: number;
  /** Plain text (markdown formatting stripped) shown in the TOC. */
  text: string;
}

interface HtmlHeading {
  level: number;
  text: string;
}

const markdownParser = new MarkdownIt({ html: true, linkify: false, typographer: false });
const HTML_HEADING_OPEN_PATTERN = /<h([1-6])\b[^>]*>/gi;
const NON_RENDERED_HTML_BLOCK_PATTERN =
  /<!--([\s\S]*?)(?:-->|$)|<\?(?:[\s\S]*?)(?:\?>|$)|<!\[CDATA\[(?:[\s\S]*?)(?:\]\]>|$)|<![A-Z][\s\S]*?(?:>|$)|<(?:script|style)(?=[\s>]|$)[\s\S]*?(?:<\/(?:script|style)\s*>|$)/gi;

const IMPLICIT_HEADING_BOUNDARY_PATTERN =
  /<h[1-6]\b[^>]*>|<\/?(?:address|article|aside|blockquote|details|dialog|div|dl|dt|dd|fieldset|figcaption|figure|footer|form|header|hr|li|main|nav|ol|p|pre|section|summary|table|tbody|td|tfoot|th|thead|tr|ul)\b[^>]*>/i;

/**
 * Extract heading entries from a plan's markdown source.
 *
 * Markdown block structure is delegated to markdown-it so ATX, setext,
 * blockquote/list containers, indented code, and fenced code stay aligned with
 * the rendered markdown. Raw HTML h1-h6 tags are counted separately because the
 * renderer allows raw HTML and those tags also appear in the heading NodeList.
 */
export function extractPlanHeadings(markdown: string): PlanHeading[] {
  if (!markdown) {
    return [];
  }

  const tokens = markdownParser.parse(markdown, {});
  const headings: PlanHeading[] = [];
  let renderIndex = 0;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (token.type === "heading_open") {
      const level = parseHeadingLevel(token.tag);
      const inline = tokens[i + 1];
      const text = stripMarkdownFormatting(inline?.type === "inline" ? inline.content : "");
      if (text) {
        headings.push({ renderIndex, level, text });
      }
      // Empty markdown headings still render hN elements, so they consume an
      // index even when they do not produce a useful TOC entry.
      renderIndex += 1;
      continue;
    }

    if (token.type === "inline" && tokens[i - 1]?.type !== "heading_open") {
      const children = token.children ?? [];
      if (children.some((child) => child.type === "html_inline")) {
        const inlineHtml = reconstructInlineHtml(children);
        for (const htmlHeading of extractHtmlHeadings(inlineHtml)) {
          if (htmlHeading.text) {
            headings.push({ renderIndex, level: htmlHeading.level, text: htmlHeading.text });
          }
          renderIndex += 1;
        }
      }
      continue;
    }

    if (token.type === "html_block" || token.type === "html_inline") {
      for (const htmlHeading of extractHtmlHeadings(token.content)) {
        if (htmlHeading.text) {
          headings.push({ renderIndex, level: htmlHeading.level, text: htmlHeading.text });
        }
        // Empty raw HTML headings still render hN elements, so they consume an
        // index even when they do not produce a useful TOC entry.
        renderIndex += 1;
      }
    }
  }

  return headings;
}

interface InlineTokenChild {
  type: string;
  content: string;
}

function reconstructInlineHtml(children: InlineTokenChild[]): string {
  const openTags: string[] = [];
  let html = "";

  for (const child of children) {
    if (child.type === "html_inline") {
      html += child.content;
      updateInlineHtmlStack(openTags, child.content);
      continue;
    }

    if (child.type === "text" && openTags.length > 0) {
      html += child.content;
    }
  }

  return html;
}

function updateInlineHtmlStack(openTags: string[], rawHtml: string): void {
  const tagPattern = /<\s*(\/)?\s*([A-Za-z][A-Za-z0-9:-]*)\b[^>]*(\/)?\s*>/g;
  let match = tagPattern.exec(rawHtml);
  while (match) {
    const tagName = match[2].toLowerCase();
    const isClosingTag = match[1] != null;
    const isSelfClosing = match[3] != null || /<[^>]*\/\s*>$/.test(match[0]);

    if (isClosingTag) {
      const openIndex = openTags.lastIndexOf(tagName);
      if (openIndex >= 0) {
        openTags.splice(openIndex, 1);
      }
    } else if (!isSelfClosing && !/<\/\s*[A-Za-z][A-Za-z0-9:-]*\s*>/.test(match[0])) {
      openTags.push(tagName);
    }

    match = tagPattern.exec(rawHtml);
  }
}

function parseHeadingLevel(tag: string): number {
  const level = Number(tag.replace(/^h/i, ""));
  return level >= 1 && level <= 6 ? level : 1;
}

function extractHtmlHeadings(html: string): HtmlHeading[] {
  if (!rawHtmlUsesOnlyAllowedTags(html)) {
    return [];
  }

  const renderedHtml = html.replace(NON_RENDERED_HTML_BLOCK_PATTERN, "");
  const headings: HtmlHeading[] = [];
  HTML_HEADING_OPEN_PATTERN.lastIndex = 0;

  let match = HTML_HEADING_OPEN_PATTERN.exec(renderedHtml);
  while (match) {
    const level = parseInt(match[1], 10);
    const contentStart = match.index + match[0].length;
    const contentEnd = findHtmlHeadingContentEnd(renderedHtml, contentStart, level);

    headings.push({
      level,
      text: stripMarkdownFormatting(
        renderedHtml.slice(contentStart, contentEnd).replace(/<[^>]+>/g, "")
      ),
    });

    HTML_HEADING_OPEN_PATTERN.lastIndex = Math.max(contentEnd, contentStart);
    match = HTML_HEADING_OPEN_PATTERN.exec(renderedHtml);
  }

  return headings;
}

function findHtmlHeadingContentEnd(html: string, contentStart: number, level: number): number {
  const remaining = html.slice(contentStart);
  const explicitClose = new RegExp(`</h${level}\\s*>`, "i").exec(remaining);
  const implicitBoundary = IMPLICIT_HEADING_BOUNDARY_PATTERN.exec(remaining);
  const explicitCloseIndex = explicitClose?.index;
  const implicitBoundaryIndex = implicitBoundary?.index;

  if (
    implicitBoundaryIndex != null &&
    (explicitCloseIndex == null || implicitBoundaryIndex < explicitCloseIndex)
  ) {
    return contentStart + implicitBoundaryIndex;
  }

  if (explicitCloseIndex != null) {
    return contentStart + explicitCloseIndex;
  }

  return html.length;
}

/**
 * Lightweight inline-formatting stripper used only for TOC display text. Not a
 * full markdown parser — markdown-it has already handled block structure; this
 * only normalizes raw HTML heading text and a few markdown-ish inline remnants.
 */
function stripMarkdownFormatting(text: string): string {
  return text
    .replace(/\\([\\`*_{}\x5B\]()#+\-.!|~])/g, "$1") // unescape \*  \[ etc.
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // ![alt](src)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // [label](href)
    .replace(/`([^`]+)`/g, "$1") // `code`
    .replace(/\*\*([^*]+)\*\*/g, "$1") // **bold**
    .replace(/__([^_]+)__/g, "$1") // __bold__
    .replace(/\*([^*]+)\*/g, "$1") // *italic*
    .replace(/(?<!\w)_([^_]+)_(?!\w)/g, "$1") // _italic_ (avoid mid-word matches)
    .replace(/~~([^~]+)~~/g, "$1") // ~~strike~~
    .replace(/<[^>]+>/g, "") // stray inline HTML tags
    .replace(/\s+/g, " ")
    .trim();
}
