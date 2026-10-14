import { classifyArtifactReference } from "./artifactPaths";

// ![alt](url "title") with an optional <angle-bracketed> url. Titles may use "", '' or ().
const MARKDOWN_IMAGE_PATTERN =
  /!\[([^\]\n]*)\]\(\s*(<[^>\n]+>|[^\s)]+)(\s+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?\s*\)/g;
const FENCE_PATTERN = /^\s{0,3}(`{3,}|~{3,})/;
// A closing fence is a bare marker line: no info string or other trailing text (CommonMark).
const CLOSING_FENCE_PATTERN = /^\s{0,3}(`{3,}|~{3,})\s*$/;

/**
 * Apply `transform` to every inline Markdown image outside fenced code blocks. `transform`
 * gets the raw URL (angle brackets removed) and returns a replacement URL, or null to keep it.
 */
export function mapMarkdownImageUrls(
  markdown: string,
  transform: (url: string) => string | null
): string {
  let fence: string | null = null;
  return markdown
    .split("\n")
    .map((line) => {
      if (fence != null) {
        // Inside a fence only a closing marker of the same character, at least as long as
        // the opener, ends it; every other line (fence-like or not) is code.
        const close = CLOSING_FENCE_PATTERN.exec(line);
        if (close && close[1].startsWith(fence[0]) && close[1].length >= fence.length) {
          fence = null;
        }
        return line;
      }
      const fenceMatch = FENCE_PATTERN.exec(line);
      if (fenceMatch) {
        fence = fenceMatch[1];
        return line;
      }
      return line.replace(
        MARKDOWN_IMAGE_PATTERN,
        (match, alt: string, rawUrl: string, title?: string) => {
          const url = rawUrl.startsWith("<") ? rawUrl.slice(1, -1) : rawUrl;
          const replacement = transform(url);
          return replacement == null ? match : `![${alt}](${replacement}${title ?? ""})`;
        }
      );
    })
    .join("\n");
}

/** Relative image URLs referenced by a Markdown artifact (deduplicated, in order). */
export function findRelativeMarkdownImages(markdown: string): string[] {
  const urls = new Set<string>();
  mapMarkdownImageUrls(markdown, (url) => {
    if (classifyArtifactReference(url) === "relative") urls.add(url);
    return null;
  });
  return [...urls];
}
