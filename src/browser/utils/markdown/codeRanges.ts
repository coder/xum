/**
 * Markdown code-span / fenced-code-block detection.
 *
 * Shared by inline-token features (e.g. `$skill` references and `\symbol`
 * shortcuts) that must NOT trigger inside code. Extracted from
 * inlineSkillReferences.ts so multiple consumers reuse one implementation.
 */

export interface TextRange {
  start: number;
  end: number;
}

const MIN_FENCE_MARKER_LENGTH = 3;
const MAX_FENCE_MARKER_INDENTATION = 3;
type FenceChar = "`" | "~";

interface FenceMarker {
  char: FenceChar;
  length: number;
  markerStart: number;
}

function getCharRunLength(text: string, start: number, ch: string): number {
  let end = start;
  while (end < text.length && text[end] === ch) {
    end++;
  }

  return end - start;
}

function getBacktickRunLength(text: string, start: number): number {
  return getCharRunLength(text, start, "`");
}

function isFenceChar(ch: string | undefined): ch is FenceChar {
  return ch === "`" || ch === "~";
}

function isLineStart(text: string, index: number): boolean {
  return index === 0 || text[index - 1] === "\n" || text[index - 1] === "\r";
}

function getFenceMarkerAtLineStart(text: string, index: number): FenceMarker | null {
  if (!isLineStart(text, index)) {
    return null;
  }

  let markerStart = index;
  let indentation = 0;
  while (indentation < MAX_FENCE_MARKER_INDENTATION && text[markerStart] === " ") {
    markerStart++;
    indentation++;
  }

  const ch = text[markerStart];
  if (!isFenceChar(ch)) {
    return null;
  }

  const length = getCharRunLength(text, markerStart, ch);
  if (length < MIN_FENCE_MARKER_LENGTH) {
    return null;
  }

  return { char: ch, length, markerStart };
}

function findLineEnd(text: string, start: number): number {
  let end = start;
  while (end < text.length && text[end] !== "\n" && text[end] !== "\r") {
    end++;
  }

  return end;
}

function findNextLineStart(text: string, start: number): number {
  const lineEnd = findLineEnd(text, start);
  if (lineEnd >= text.length) {
    return text.length;
  }

  return text[lineEnd] === "\r" && text[lineEnd + 1] === "\n" ? lineEnd + 2 : lineEnd + 1;
}

function hasOnlySpacesOrTabsUntilLineEnd(text: string, start: number): boolean {
  const lineEnd = findLineEnd(text, start);
  for (let index = start; index < lineEnd; index++) {
    const ch = text[index];
    if (ch !== " " && ch !== "\t") {
      return false;
    }
  }

  return true;
}

function findInlineCodeEnd(text: string, start: number, delimiterLength: number): number | null {
  let index = start;
  while (index < text.length) {
    const ch = text[index];
    if (ch === "\n" || ch === "\r") {
      return null;
    }

    if (ch !== "`") {
      index++;
      continue;
    }

    const runLength = getBacktickRunLength(text, index);
    index += runLength;

    // Markdown inline code spans close only on the first backtick run of the same length.
    if (runLength === delimiterLength) {
      return index;
    }
  }

  return null;
}

/** Collect all fenced-code-block and inline-code-span ranges in `text`. */
export function collectCodeRanges(text: string): TextRange[] {
  const ranges: TextRange[] = [];
  let index = 0;

  while (index < text.length) {
    const fenceMarker = getFenceMarkerAtLineStart(text, index);
    if (fenceMarker) {
      const fenceStart = index;
      index = findNextLineStart(text, index);

      while (index < text.length) {
        const closingFenceMarker = getFenceMarkerAtLineStart(text, index);
        if (
          closingFenceMarker &&
          closingFenceMarker.char === fenceMarker.char &&
          closingFenceMarker.length >= fenceMarker.length &&
          hasOnlySpacesOrTabsUntilLineEnd(
            text,
            closingFenceMarker.markerStart + closingFenceMarker.length
          )
        ) {
          index = closingFenceMarker.markerStart + closingFenceMarker.length;
          break;
        }

        index = findNextLineStart(text, index);
      }

      ranges.push({ start: fenceStart, end: index });
      continue;
    }

    const ch = text[index];
    if (ch === "\n" || ch === "\r") {
      index++;
      continue;
    }

    if (ch === "`") {
      const rangeStart = index;
      const delimiterLength = getBacktickRunLength(text, index);
      index += delimiterLength;

      const rangeEnd = findInlineCodeEnd(text, index, delimiterLength);
      if (rangeEnd !== null) {
        ranges.push({ start: rangeStart, end: rangeEnd });
        index = rangeEnd;
        continue;
      }

      if (delimiterLength > 1) {
        const lineEnd = findLineEnd(text, index);
        ranges.push({ start: rangeStart, end: lineEnd });
        index = lineEnd;
      }

      continue;
    }

    index++;
  }

  return ranges;
}

/** True when `position` falls within `[range.start, range.end)`. */
export function isPositionInRange(position: number, range: TextRange): boolean {
  return position >= range.start && position < range.end;
}

/** True when a cursor sits strictly inside a code range (not on its edges). */
export function isCursorInsideCodeRange(cursor: number, range: TextRange): boolean {
  return cursor > range.start && cursor < range.end;
}
