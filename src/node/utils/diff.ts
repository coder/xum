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
  if (lcs === null) {
    return `(diff omitted: the changed region is too large to diff, ${oldLines.length} lines before and ${newLines.length} lines after; read the file for its current content)`;
  }
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
 * About the most lines a diff may remove plus add (each bisection stops after half of it, so
 * the exact cut is a few lines higher). A larger change reaches the model as a notice: such a
 * diff is no more useful than reading the file, and the limit bounds the search below.
 */
const MAX_EDIT_DISTANCE = 4_000;

/**
 * Most search steps (diagonals visited plus lines compared) one diff may take, so a very
 * long file with a change under MAX_EDIT_DISTANCE still ends quickly on the send path.
 */
const MAX_DIFF_STEPS = 20_000_000;

/**
 * Compute longest common subsequence indices.
 * Returns array of [oldIndex, newIndex] pairs for matching lines, or null when the change
 * passes MAX_EDIT_DISTANCE or the search passes MAX_DIFF_STEPS.
 *
 * Linear-space Myers diff: memory is O(lines), never lines x lines. A full LCS table for
 * two 22.5k-line files was about 4 GB and took the server to its heap limit.
 */
function computeLCS(oldLines: string[], newLines: string[]): LCSMatch[] | null {
  // Lines shared at the start and end always match; only the middle needs the search.
  const { prefix, suffix } = commonEdges(oldLines, newLines);
  const [a, b] = lineIds(
    oldLines.slice(prefix, oldLines.length - suffix),
    newLines.slice(prefix, newLines.length - suffix)
  );
  const middle = myersMatches(a, b);
  if (middle === null) return null;

  const matches: LCSMatch[] = [];
  for (let k = 0; k < prefix; k++) matches.push([k, k]);
  for (const [i, j] of middle) matches.push([prefix + i, prefix + j]);
  for (let k = suffix - 1; k >= 0; k--) {
    matches.push([oldLines.length - 1 - k, newLines.length - 1 - k]);
  }
  return matches;
}

/** How many lines both files share at the start, and then at the end. */
function commonEdges(oldLines: string[], newLines: string[]): { prefix: number; suffix: number } {
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++;
  }
  return { prefix, suffix };
}

/** One number per distinct line, so the search compares numbers instead of strings. */
function lineIds(oldLines: string[], newLines: string[]): [Int32Array, Int32Array] {
  const ids = new Map<string, number>();
  const toIds = (lines: string[]) =>
    Int32Array.from(lines, (line) => {
      let id = ids.get(line);
      if (id === undefined) {
        id = ids.size;
        ids.set(line, id);
      }
      return id;
    });
  return [toIds(oldLines), toIds(newLines)];
}

/** A half-open range of a and one of b still to diff. */
type DiffRange = [aLo: number, aHi: number, bLo: number, bHi: number];

/**
 * Matching [aIndex, bIndex] pairs of a shortest edit script, ascending, or null past a
 * limit. Each range trims its common start and end, then a bisection finds a point on a
 * shortest path and splits the range there (Myers 1986, as in diff-match-patch).
 */
function myersMatches(a: Int32Array, b: Int32Array): LCSMatch[] | null {
  const matches: LCSMatch[] = [];
  const budget = { steps: MAX_DIFF_STEPS };
  const ranges: DiffRange[] = [[0, a.length, 0, b.length]];
  for (let range = ranges.pop(); range !== undefined; range = ranges.pop()) {
    const [aLo, aHi, bLo, bHi] = trimRange(a, b, range, matches);
    if (aLo === aHi || bLo === bHi) continue;
    const split = bisect(a.subarray(aLo, aHi), b.subarray(bLo, bHi), budget);
    if (split === null) return null;
    if (split === "disjoint") continue;
    const [x, y] = split;
    assertShrinks(x + y, aHi - aLo + (bHi - bLo));
    ranges.push([aLo, aLo + x, bLo, bLo + y], [aLo + x, aHi, bLo + y, bHi]);
  }
  return matches.sort((p, q) => p[0] - q[0]);
}

/** Record the lines a range shares at its start and end as matches, and return the rest. */
function trimRange(a: Int32Array, b: Int32Array, range: DiffRange, matches: LCSMatch[]): DiffRange {
  let [aLo, aHi, bLo, bHi] = range;
  while (aLo < aHi && bLo < bHi && a[aLo] === b[bLo]) matches.push([aLo++, bLo++]);
  while (aLo < aHi && bLo < bHi && a[aHi - 1] === b[bHi - 1]) matches.push([--aHi, --bHi]);
  return [aLo, aHi, bLo, bHi];
}

/**
 * The split lies strictly inside the range (its ends differ), so each part is smaller and the
 * loop ends. A plain throw, not assert: this module has no imports (its large-file test runs
 * it alone in a child process).
 */
function assertShrinks(splitAt: number, rangeSize: number): void {
  if (splitAt <= 0 || splitAt >= rangeSize) throw new Error("Myers split must shrink the range");
}

/** Forward or backward search state of one bisection. */
interface SearchSide {
  /** Furthest x reached on each diagonal k, at index offset + k (-1: not reached). */
  v: Int32Array;
  /** Diagonals that ran off the end or bottom, trimmed from the next rounds. */
  kStart: number;
  kEnd: number;
}

/**
 * Find a point where the forward and backward searches of a shortest edit path meet: [x, y],
 * "disjoint" when a and b share no line, or null past MAX_EDIT_DISTANCE or the step budget.
 */
function bisect(
  a: Int32Array,
  b: Int32Array,
  budget: { steps: number }
): [number, number] | "disjoint" | null {
  const maxD = Math.ceil((a.length + b.length) / 2);
  // The paths meet after about half the edit distance on each side.
  const dLimit = Math.min(maxD, Math.ceil(MAX_EDIT_DISTANCE / 2) + 1);
  const offset = dLimit + 1;
  const newSide = (): SearchSide => {
    const v = new Int32Array(2 * offset + 2).fill(-1);
    v[offset + 1] = 0;
    return { v, kStart: 0, kEnd: 0 };
  };
  const forward = newSide();
  const backward = newSide();
  const delta = a.length - b.length;
  for (let d = 0; d < dLimit; d++) {
    // Not ??: a null (step budget spent) from the forward round must end the search too.
    const forwardMet = searchRound(a, b, d, offset, forward, backward, delta, false, budget);
    if (forwardMet !== undefined) return forwardMet;
    const backwardMet = searchRound(a, b, d, offset, backward, forward, delta, true, budget);
    if (backwardMet !== undefined) return backwardMet;
  }
  return dLimit < maxD ? null : "disjoint";
}

/**
 * Extend one side's paths by one edit (round d). Returns where it meets the other side, null
 * when the step budget runs out, or undefined to continue.
 */
function searchRound(
  a: Int32Array,
  b: Int32Array,
  d: number,
  offset: number,
  side: SearchSide,
  other: SearchSide,
  delta: number,
  isBackward: boolean,
  budget: { steps: number }
): [number, number] | null | undefined {
  // The forward side checks for overlap when delta is odd, the backward side when it is even.
  const checksOverlap = (delta % 2 !== 0) !== isBackward;
  for (let k = -d + side.kStart; k <= d - side.kEnd; k += 2) {
    const start = pathStart(side.v, offset + k, k, d);
    const x = followSnake(a, b, start, start - k, isBackward);
    budget.steps -= 1 + x - start;
    if (budget.steps < 0) return null;
    if (recordPathEnd(side, offset + k, x, x - k, a.length, b.length) && checksOverlap) {
      const met = overlap(offset + delta - k, other, a.length, [x, x - k], isBackward, offset);
      if (met !== undefined) return met;
    }
  }
  return undefined;
}

/** Where the path on diagonal k starts in round d: one step down or right from a neighbor. */
function pathStart(v: Int32Array, kOffset: number, k: number, d: number): number {
  return k === -d || (k !== d && v[kOffset - 1] < v[kOffset + 1])
    ? v[kOffset + 1]
    : v[kOffset - 1] + 1;
}

/** Follow equal lines from [x, y] (from the ends for the backward side); returns the end x. */
function followSnake(a: Int32Array, b: Int32Array, x: number, y: number, fromEnd: boolean): number {
  let end = x;
  while (end < a.length && y + end - x < b.length) {
    if (lineAt(a, end, fromEnd) !== lineAt(b, y + end - x, fromEnd)) break;
    end++;
  }
  return end;
}

/**
 * Save how far the path on a diagonal got. Returns false when it ran off the end of a or b
 * (that diagonal is dropped from later rounds), true when it is still inside both.
 */
function recordPathEnd(
  side: SearchSide,
  kOffset: number,
  x: number,
  y: number,
  n: number,
  m: number
): boolean {
  side.v[kOffset] = x;
  if (x > n) side.kEnd += 2;
  else if (y > m) side.kStart += 2;
  else return true;
  return false;
}

/** Line i of a from the start, or from the end for the backward side. */
function lineAt(lines: Int32Array, i: number, fromEnd: boolean): number {
  return lines[fromEnd ? lines.length - 1 - i : i];
}

/**
 * Where the two sides meet on the matching diagonal (otherOffset), if the other side already
 * reached past this side's point. The result is always the forward side's point.
 */
function overlap(
  otherOffset: number,
  other: SearchSide,
  n: number,
  point: [number, number],
  isBackward: boolean,
  offset: number
): [number, number] | undefined {
  if (otherOffset < 0 || otherOffset >= other.v.length || other.v[otherOffset] === -1) {
    return undefined;
  }
  const otherX = other.v[otherOffset];
  if (!isBackward) return point[0] >= n - otherX ? point : undefined;
  // other is the forward side: its point on that diagonal is [otherX, otherX - k].
  return otherX >= n - point[0] ? [otherX, offset + otherX - otherOffset] : undefined;
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
