/**
 * Simple line-based diff utility for detecting external file edits.
 * Uses timestamp-based polling with diff injection.
 */

/**
 * Compute a unified diff between old and new content.
 * Returns null if contents are identical.
 *
 * The diff format shows:
 * - Lines prefixed with '-' were removed
 * - Lines prefixed with '+' were added
 * - Context lines (unchanged) are shown around changes
 */
export function computeDiff(oldContent: string, newContent: string): string | null {
  if (oldContent === newContent) return null;

  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");

  // Simple line-by-line comparison with context
  const changes: string[] = [];
  const contextSize = 3;

  // Find all changed line ranges using longest common subsequence approach
  const lcs = computeLCS(oldLines, newLines);
  const hunks = buildHunks(oldLines, newLines, lcs, contextSize);

  if (hunks.length === 0) {
    // Edge case: whitespace-only differences that don't show up in line comparison
    return null;
  }

  for (const hunk of hunks) {
    changes.push(
      `@@ -${hunk.oldStart + 1},${hunk.oldCount} +${hunk.newStart + 1},${hunk.newCount} @@`
    );
    changes.push(...hunk.lines);
  }

  return changes.join("\n");
}

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
}

type LCSMatch = [number, number];

/**
 * Compute longest common subsequence indices.
 * Returns array of [oldIndex, newIndex] pairs for matching lines.
 */
function computeLCS(oldLines: string[], newLines: string[]): LCSMatch[] {
  const m = oldLines.length;
  const n = newLines.length;

  // Build LCS table
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array.from({ length: n + 1 }, () => 0)
  );

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to find matching pairs
  const result: LCSMatch[] = [];
  let i = m;
  let j = n;

  while (i > 0 && j > 0) {
    if (oldLines[i - 1] === newLines[j - 1]) {
      result.unshift([i - 1, j - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  return result;
}

/**
 * Build unified diff hunks from LCS matches.
 */
function buildHunks(
  oldLines: string[],
  newLines: string[],
  lcs: LCSMatch[],
  contextSize: number
): Hunk[] {
  const hunks: Hunk[] = [];
  let currentHunk: Hunk | null = null;

  let oldIdx = 0;
  let newIdx = 0;
  let lcsIdx = 0;

  while (oldIdx < oldLines.length || newIdx < newLines.length) {
    const match = lcsIdx < lcs.length ? lcs[lcsIdx] : null;

    if (match?.[0] === oldIdx && match[1] === newIdx) {
      // Matching line
      if (currentHunk) {
        currentHunk.lines.push(` ${oldLines[oldIdx]}`);
        currentHunk.oldCount++;
        currentHunk.newCount++;
      }
      oldIdx++;
      newIdx++;
      lcsIdx++;
    } else {
      // Non-matching: we have deletions or additions
      const startHunk = !currentHunk;
      if (startHunk) {
        // Start new hunk with context
        currentHunk = {
          oldStart: Math.max(0, oldIdx - contextSize),
          oldCount: 0,
          newStart: Math.max(0, newIdx - contextSize),
          newCount: 0,
          lines: [],
        };

        // Add leading context
        const contextStart = Math.max(0, oldIdx - contextSize);
        for (let c = contextStart; c < oldIdx; c++) {
          currentHunk.lines.push(` ${oldLines[c]}`);
          currentHunk.oldCount++;
          currentHunk.newCount++;
        }
      }

      // Add deletions (old lines not in new)
      while (oldIdx < oldLines.length && (!match || oldIdx < match[0])) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- legacy site from before the ban; remove when touching this line
        currentHunk!.lines.push(`-${oldLines[oldIdx]}`);
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- legacy site from before the ban; remove when touching this line
        currentHunk!.oldCount++;
        oldIdx++;
      }

      // Add additions (new lines not in old)
      while (newIdx < newLines.length && (!match || newIdx < match[1])) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- legacy site from before the ban; remove when touching this line
        currentHunk!.lines.push(`+${newLines[newIdx]}`);
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- legacy site from before the ban; remove when touching this line
        currentHunk!.newCount++;
        newIdx++;
      }
    }

    // Check if we should close the hunk (enough context after changes)
    if (currentHunk && match?.[0] === oldIdx && match[1] === newIdx) {
      // Look ahead to see if there are more changes within context range
      const nextNonMatch = findNextNonMatch(oldIdx, newIdx, lcs, lcsIdx, oldLines, newLines);

      if (nextNonMatch === null || nextNonMatch > contextSize * 2) {
        // No more changes nearby, add trailing context and close hunk
        let contextAdded = 0;
        while (
          contextAdded < contextSize &&
          oldIdx < oldLines.length &&
          newIdx < newLines.length &&
          lcsIdx < lcs.length &&
          lcs[lcsIdx][0] === oldIdx &&
          lcs[lcsIdx][1] === newIdx
        ) {
          currentHunk.lines.push(` ${oldLines[oldIdx]}`);
          currentHunk.oldCount++;
          currentHunk.newCount++;
          oldIdx++;
          newIdx++;
          lcsIdx++;
          contextAdded++;
        }

        hunks.push(currentHunk);
        currentHunk = null;
      }
    }
  }

  // Close any remaining hunk
  if (currentHunk) {
    hunks.push(currentHunk);
  }

  return hunks;
}

/**
 * Find distance to next non-matching pair.
 */
function findNextNonMatch(
  oldIdx: number,
  newIdx: number,
  lcs: LCSMatch[],
  lcsIdx: number,
  oldLines: string[],
  newLines: string[]
): number | null {
  let distance = 0;
  let oi = oldIdx;
  let ni = newIdx;
  let li = lcsIdx;

  while (oi < oldLines.length && ni < newLines.length && li < lcs.length) {
    if (lcs[li][0] === oi && lcs[li][1] === ni) {
      oi++;
      ni++;
      li++;
      distance++;
    } else {
      return distance;
    }
  }

  // Reached end of one or both arrays
  if (oi < oldLines.length || ni < newLines.length) {
    return distance;
  }

  return null;
}
