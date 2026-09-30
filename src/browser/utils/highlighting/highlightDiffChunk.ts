import { highlightCode } from "./highlightWorkerClient";
import { isLightThemeMode } from "./shiki-shared";
import type { ThemeMode } from "@/browser/contexts/ThemeContext";
import type { DiffChunk } from "./diffChunking";

/**
 * Chunk-based diff highlighting with Shiki (via Web Worker)
 *
 * Highlighting runs off-main-thread to avoid blocking UI during large diffs.
 *
 * Current approach: Parse Shiki HTML to extract individual line HTMLs
 * - Groups consecutive lines by type (add/remove/context)
 * - Highlights each chunk with Shiki in web worker
 * - Extracts per-line HTML for individual rendering
 *
 * Future optimization: Could render entire <code> blocks and use CSS to style
 * .line spans instead of extracting per-line HTML. Would simplify parsing
 * and reduce dangerouslySetInnerHTML usage.
 *
 * Size policy: allow human-scale files (including 10k-LoC chunks) to attempt
 * highlighting, but skip payloads that are too large or too minified to hand to
 * the worker without visible renderer-thread pre-processing cost. The worker
 * client still owns the runtime budget once a payload is handed off.
 */

// Synchronous safety budget before the worker boundary. These are intentionally
// far above human-scale source files but catch generated/minified hunks where
// joining and structured-cloning the payload would itself be the UI stall.
const MAX_DIFF_HIGHLIGHT_SYNC_CHARS = 2_000_000;
const MAX_DIFF_HIGHLIGHT_LINE_CHARS = 20_000;

export function isWithinDiffHighlightSyncBudget(lines: string[]): boolean {
  let totalChars = Math.max(0, lines.length - 1); // account for join("\n") separators
  for (const line of lines) {
    if (line.length > MAX_DIFF_HIGHLIGHT_LINE_CHARS) return false;
    totalChars += line.length;
    if (totalChars > MAX_DIFF_HIGHLIGHT_SYNC_CHARS) return false;
  }
  return true;
}

export interface HighlightedLine {
  html: string; // HTML content (already escaped and tokenized)
  oldLineNumber: number | null;
  newLineNumber: number | null;
  originalIndex: number; // Index in original diff
}

export interface HighlightedChunk {
  type: DiffChunk["type"];
  lines: HighlightedLine[];
  usedFallback: boolean; // True if highlighting failed
}

/**
 * Highlight a chunk of code using Shiki.
 * Falls back to plain text on error.
 */
export async function highlightDiffChunk(
  chunk: DiffChunk,
  language: string,
  themeMode: ThemeMode = "dark"
): Promise<HighlightedChunk> {
  const [highlighted] = await highlightDiffChunks([chunk], language, themeMode);
  return highlighted ?? createFallbackChunk(chunk);
}

interface DiffLineRef {
  chunkIndex: number;
  lineIndex: number;
}

interface DiffHighlightSegment {
  lines: string[];
  refs: DiffLineRef[];
  lastLineNumber: number | null;
}

function appendSegmentLine(
  segments: DiffHighlightSegment[],
  lineNumber: number,
  line: string,
  ref: DiffLineRef
): void {
  const currentSegment = segments[segments.length - 1];
  if (currentSegment?.lastLineNumber == null || lineNumber !== currentSegment.lastLineNumber + 1) {
    segments.push({ lines: [], refs: [], lastLineNumber: null });
  }

  const targetSegment = segments[segments.length - 1];
  targetSegment.lines.push(line);
  targetSegment.refs.push(ref);
  targetSegment.lastLineNumber = lineNumber;
}

function buildVersionedHighlightSegments(chunks: readonly DiffChunk[]): {
  oldSegments: DiffHighlightSegment[];
  newSegments: DiffHighlightSegment[];
} {
  const oldSegments: DiffHighlightSegment[] = [];
  const newSegments: DiffHighlightSegment[] = [];

  chunks.forEach((chunk, chunkIndex) => {
    chunk.lines.forEach((line, lineIndex) => {
      const ref = { chunkIndex, lineIndex };
      const oldLineNumber = chunk.oldLineNumbers[lineIndex];
      const newLineNumber = chunk.newLineNumbers[lineIndex];

      if (oldLineNumber !== null) {
        appendSegmentLine(oldSegments, oldLineNumber, line, ref);
      }
      if (newLineNumber !== null) {
        appendSegmentLine(newSegments, newLineNumber, line, ref);
      }
    });
  });

  return { oldSegments, newSegments };
}

async function highlightSegments(
  segments: readonly DiffHighlightSegment[],
  language: string,
  workerTheme: "dark" | "light",
  lineHtmlByChunk: Array<Array<string | undefined>>
): Promise<boolean> {
  for (const segment of segments) {
    const html = await highlightCode(segment.lines.join("\n"), language, workerTheme);
    const lines = extractLinesFromHtml(html);

    if (lines.length !== segment.lines.length) {
      return false;
    }

    const hasEmptyExtraction = lines.some(
      (extractedHtml, i) => extractedHtml.length === 0 && segment.lines[i].length > 0
    );
    if (hasEmptyExtraction) {
      return false;
    }

    segment.refs.forEach((ref, index) => {
      lineHtmlByChunk[ref.chunkIndex][ref.lineIndex] = lines[index];
    });
  }

  return true;
}

/**
 * Highlight all rendered diff chunks with Shiki while preserving old/new file versions.
 *
 * Immersive review can hydrate a full-file overlay into hundreds of tiny
 * add/remove/context chunks. Sending each chunk through Comlink separately makes
 * syntax coloring visibly replace the plain fallback after first paint. We still
 * keep old and new line streams separate so syntax state from removed code never
 * bleeds into added rows from the other version of the file.
 */
export async function highlightDiffChunks(
  chunks: readonly DiffChunk[],
  language: string,
  themeMode: ThemeMode = "dark"
): Promise<HighlightedChunk[]> {
  if (chunks.length === 0) {
    return [];
  }

  // Fast path: no highlighting for text files, but still escape attacker-controlled text.
  if (language === "text" || language === "plaintext") {
    return chunks.map((chunk) => createPlainTextChunk(chunk, false));
  }

  const { oldSegments, newSegments } = buildVersionedHighlightSegments(chunks);
  const sourceLines = [...oldSegments, ...newSegments].flatMap((segment) => segment.lines);
  if (sourceLines.length === 0 || !isWithinDiffHighlightSyncBudget(sourceLines)) {
    return chunks.map(createFallbackChunk);
  }

  const workerTheme = isLightThemeMode(themeMode) ? "light" : "dark";

  try {
    const lineHtmlByChunk = chunks.map(
      (chunk) => new Array<string | undefined>(chunk.lines.length)
    );
    const highlightedOld = await highlightSegments(
      oldSegments,
      language,
      workerTheme,
      lineHtmlByChunk
    );
    const highlightedNew = await highlightSegments(
      newSegments,
      language,
      workerTheme,
      lineHtmlByChunk
    );

    if (!highlightedOld || !highlightedNew) {
      return chunks.map(createFallbackChunk);
    }

    return chunks.map((chunk, chunkIndex) => ({
      type: chunk.type,
      lines: chunk.lines.map((_, lineIndex) => {
        const html = lineHtmlByChunk[chunkIndex][lineIndex];
        if (html === undefined) {
          return {
            html: escapeHtml(chunk.lines[lineIndex]),
            oldLineNumber: chunk.oldLineNumbers[lineIndex],
            newLineNumber: chunk.newLineNumbers[lineIndex],
            originalIndex: chunk.startIndex + lineIndex,
          };
        }

        return {
          html,
          oldLineNumber: chunk.oldLineNumbers[lineIndex],
          newLineNumber: chunk.newLineNumbers[lineIndex],
          originalIndex: chunk.startIndex + lineIndex,
        };
      }),
      usedFallback: false,
    }));
  } catch (error) {
    console.warn(
      `Syntax highlighting failed for language ${language} (${sourceLines.length} lines):`,
      error
    );
    return chunks.map(createFallbackChunk);
  }
}

/**
 * Create plain text fallback for a chunk.
 */
function createFallbackChunk(chunk: DiffChunk): HighlightedChunk {
  return createPlainTextChunk(chunk, true);
}

function createPlainTextChunk(chunk: DiffChunk, usedFallback: boolean): HighlightedChunk {
  return {
    type: chunk.type,
    lines: chunk.lines.map((line, i) => ({
      html: escapeHtml(line),
      oldLineNumber: chunk.oldLineNumbers[i],
      newLineNumber: chunk.newLineNumbers[i],
      originalIndex: chunk.startIndex + i,
    })),
    usedFallback,
  };
}

/**
 * Extract individual line contents from Shiki's HTML output
 * Shiki wraps output in <pre><code>...</code></pre> with <span class="line">...</span> per line
 *
 * Strategy: Split on newlines (which separate line spans), then extract inner HTML
 * from each line span. This handles nested spans correctly.
 */
function extractLinesFromHtml(html: string): string[] {
  // Remove <pre> and <code> wrappers
  const codeRegex = /<code[^>]*>(.*?)<\/code>/s;
  const codeMatch = codeRegex.exec(html);
  if (!codeMatch) return [];

  const codeContent = codeMatch[1];

  // Split by newlines - Shiki separates line spans with \n
  const lineChunks = codeContent.split("\n");

  return lineChunks
    .map((chunk) => {
      // Extract content from <span class="line">CONTENT</span>
      // We need to handle nested spans, so we:
      // 1. Find the opening tag
      // 2. Find the LAST closing </span> (which closes the line wrapper)
      // 3. Extract everything between them

      const openTag = '<span class="line">';
      const closeTag = "</span>";

      const openIndex = chunk.indexOf(openTag);
      if (openIndex === -1) {
        // No line span - might be empty line or malformed
        return "";
      }

      const contentStart = openIndex + openTag.length;
      const closeIndex = chunk.lastIndexOf(closeTag);
      if (closeIndex === -1 || closeIndex < contentStart) {
        // Malformed - no closing tag
        return "";
      }

      return chunk.substring(contentStart, closeIndex);
    })
    .filter((line) => line !== null); // Remove malformed lines
}

/**
 * Escape HTML entities for plain text fallback
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
