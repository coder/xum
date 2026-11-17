/**
 * Shared utilities for parsing YAML-frontmatter markdown files (SKILL.md, AGENT.md, etc.).
 * Extracted from parseAgentDefinitionMarkdown.ts and parseSkillMarkdown.ts to deduplicate.
 */

/** Normalize \r\n and \r line endings to \n. */
export function normalizeNewlines(input: string): string {
  return input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** Strip the UTF-8 BOM (U+FEFF) if present at the start of the string. */
export function stripUtf8Bom(input: string): string {
  return input.startsWith("\uFEFF") ? input.slice(1) : input;
}

/**
 * The frontmatter YAML text and the body of normalized Markdown text. No frontmatter: empty YAML
 * and the whole text as the body. Null for an unclosed block.
 */
export function splitFrontmatter(text: string): { yaml: string; body: string } | null {
  const lines = text.split("\n");
  if ((lines[0] ?? "").trim() !== "---") return { yaml: "", body: text };
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end === -1) return null;
  return { yaml: lines.slice(1, end).join("\n"), body: lines.slice(end + 1).join("\n") };
}

export function firstNonEmptyLine(text: string): string | undefined {
  return text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
}

/**
 * `text` cut to at most `cap` UTF-16 units, the unit Zod's `.max()` counts. A cut that would end
 * on the first half of a surrogate pair drops that half, so the text stays well formed.
 */
export function cutToCap(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const cut = text.slice(0, cap);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** Format Zod validation issues into a semicolon-delimited summary string. */
export function formatZodIssues(
  issues: ReadonlyArray<{ path: readonly PropertyKey[]; message: string }>
): string {
  return issues
    .map((issue) => {
      const issuePath =
        issue.path.length > 0 ? issue.path.map((part) => String(part)).join(".") : "<root>";
      return `${issuePath}: ${issue.message}`;
    })
    .join("; ");
}
