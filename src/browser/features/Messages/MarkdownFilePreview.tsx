import { cn } from "@/common/lib/utils";
import { fenceFrontmatter } from "@/common/utils/markdownFrontmatter";
import { MarkdownRenderer } from "./MarkdownRenderer";

interface MarkdownFilePreviewProps {
  content: string;
  className?: string;
}

/**
 * A Markdown file (memory file, AGENTS.md) rendered as standard Markdown, with its leading
 * frontmatter shown as a yaml block. Raw HTML, comments included, shows as typed: agents read
 * these files verbatim, so the view must not hide any of their text.
 *
 * SECURITY AUDIT: file contents are attacker-influenceable; they reach the DOM only through
 * MarkdownCore's sanitize and harden pipeline, with raw HTML rendered as text.
 */
export function MarkdownFilePreview(props: MarkdownFilePreviewProps) {
  return (
    <MarkdownRenderer
      content={fenceFrontmatter(props.content)}
      renderRawHtml={false}
      // Long unbroken URLs and paths must wrap instead of widening the sidebar.
      className={cn("min-w-0 [overflow-wrap:anywhere]", props.className)}
    />
  );
}
