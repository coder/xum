/**
 * Leading YAML frontmatter block; group 1 is the YAML between the `---` lines. The backend parses
 * memory descriptions with it and the Markdown file preview fences it, so both agree on what the
 * frontmatter is.
 */
export const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/**
 * A fenced `yaml` code block that shows frontmatter with its `---` lines. The fence is longer than
 * any backtick run in the YAML, so a ``` inside a value cannot close the block early.
 */
export function formatFrontmatterBlock(yaml: string): string {
  // A loop, not Math.max(...runs): a huge file has more runs than a call accepts as arguments.
  let longestBacktickRun = 0;
  for (const run of yaml.match(/`+/g) ?? []) {
    longestBacktickRun = Math.max(longestBacktickRun, run.length);
  }
  const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
  return `${fence}yaml\n---\n${yaml}\n---\n${fence}`;
}

/**
 * Rewrite leading frontmatter as a fenced yaml block. Rendered as is, GFM would turn it into a
 * thematic break plus a setext heading.
 */
export function fenceFrontmatter(markdown: string): string {
  const match = FRONTMATTER_PATTERN.exec(markdown);
  if (!match) return markdown;
  return `${formatFrontmatterBlock(match[1])}\n\n${markdown.slice(match[0].length)}`;
}
