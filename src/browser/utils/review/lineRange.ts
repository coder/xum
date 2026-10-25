import type { ReviewNoteData } from "@/common/types/review";

/**
 * Format a review lineRange string for compact display.
 *
 * Input examples:
 * - "-10-14 +10-15"
 * - "-5"
 * - "+5-10"
 *
 * Output examples:
 * - "10-15" (prefers new lines, falls back to old)
 * - "5"
 */
export function formatLineRangeCompact(lineRange: string): string {
  // Extract new line range (after +) if present
  const newMatch = /(?:^|\s)\+(\d+(?:-\d+)?)/.exec(lineRange);
  if (newMatch) return newMatch[1];

  // Fall back to old line range (after -)
  const oldMatch = /(?:^|\s)-(\d+(?:-\d+)?)/.exec(lineRange);
  if (oldMatch) return oldMatch[1];

  // Fallback: return as-is
  return lineRange;
}

/** Header label for a review card: `path:L10-12`, or `path · v3` for an artifact comment. */
export function formatReviewLocationLabel(data: ReviewNoteData, compact = false): string {
  if (data.artifact != null) {
    const version = data.artifact.version > 0 ? `v${data.artifact.version}` : "live";
    return compact ? version : `${data.filePath} · ${version}`;
  }
  const range = `L${formatLineRangeCompact(data.lineRange)}`;
  return compact ? range : `${data.filePath}:${range}`;
}
