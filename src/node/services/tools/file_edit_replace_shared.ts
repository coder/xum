/**
 * Shared implementation for file edit replace tools
 *
 * These helpers are used by both string-based and line-based replace tools,
 * providing the core logic while keeping the tool definitions simple for AI providers.
 */

import {
  EDIT_FAILED_NOTE_PREFIX,
  NOTE_READ_FILE_FIRST_RETRY,
  NOTE_READ_FILE_RETRY,
  NOTE_READ_FILE_AGAIN_RETRY,
  type FileEditReplaceStringToolArgs,
  type FileEditReplaceLinesToolArgs,
} from "@/common/types/tools";

import { convertNewlines, detectFileEol, normalizeNewlinesToLF } from "./eol";

interface OperationMetadata {
  edits_applied: number;
  lines_replaced?: number;
  line_delta?: number;
}

export interface OperationResult {
  success: true;
  newContent: string;
  metadata: OperationMetadata;
}

export interface OperationError {
  success: false;
  error: string;
  note?: string; // Agent-only message (not displayed in UI)
}

export type OperationOutcome = OperationResult | OperationError;

// Re-export schema-derived types for backward compatibility.
// Local code previously imported StringReplaceArgs / LineReplaceArgs from this module.
export type StringReplaceArgs = FileEditReplaceStringToolArgs;
export type LineReplaceArgs = FileEditReplaceLinesToolArgs;

/**
 * Handle string-based replacement
 */
export function handleStringReplace(
  args: StringReplaceArgs,
  originalContent: string
): OperationOutcome {
  const replaceCount = args.replace_count ?? 1;

  const fileEol = detectFileEol(originalContent);
  const oldStringExact = args.old_string;
  const oldStringCoerced = convertNewlines(args.old_string, fileEol);
  const newStringCoerced = convertNewlines(args.new_string, fileEol);

  // Prefer an exact match, but retry with normalized newline styles so Windows
  // CRLF files can be edited using model-generated LF strings.
  let oldStringToMatch = oldStringExact;
  if (
    !originalContent.includes(oldStringToMatch) &&
    oldStringCoerced !== oldStringExact &&
    originalContent.includes(oldStringCoerced)
  ) {
    oldStringToMatch = oldStringCoerced;
  }

  if (!originalContent.includes(oldStringToMatch)) {
    return {
      success: false,
      error: "old_string not found in file. The text to replace must exist in the file.",
      note: `${EDIT_FAILED_NOTE_PREFIX} The old_string does not exist in the file. ${NOTE_READ_FILE_FIRST_RETRY}`,
    };
  }

  const parts = originalContent.split(oldStringToMatch);
  const occurrences = parts.length - 1;

  if (replaceCount === 1 && occurrences > 1) {
    return {
      success: false,
      error: `old_string appears ${occurrences} times in the file. Either expand the context to make it unique or set replace_count to ${occurrences} or -1.`,
      note: `${EDIT_FAILED_NOTE_PREFIX} The old_string matched ${occurrences} locations. Add more surrounding context to make it unique, or set replace_count=${occurrences} to replace all occurrences.`,
    };
  }

  if (replaceCount > occurrences && replaceCount !== -1) {
    return {
      success: false,
      error: `replace_count is ${replaceCount} but old_string only appears ${occurrences} time(s) in the file.`,
      note: `${EDIT_FAILED_NOTE_PREFIX} The replace_count=${replaceCount} is too high. Retry with replace_count=${occurrences} or -1.`,
    };
  }

  let newContent: string;
  let editsApplied: number;

  if (replaceCount === -1) {
    newContent = parts.join(newStringCoerced);
    editsApplied = occurrences;
  } else {
    let replacedCount = 0;
    let currentContent = originalContent;

    for (let i = 0; i < replaceCount; i++) {
      const index = currentContent.indexOf(oldStringToMatch);
      if (index === -1) {
        break;
      }

      currentContent =
        currentContent.substring(0, index) +
        newStringCoerced +
        currentContent.substring(index + oldStringToMatch.length);
      replacedCount++;
    }

    newContent = currentContent;
    editsApplied = replacedCount;
  }

  return {
    success: true,
    newContent,
    metadata: {
      edits_applied: editsApplied,
    },
  };
}

/**
 * Handle line-range replacement
 */
export function handleLineReplace(
  args: LineReplaceArgs,
  originalContent: string
): OperationOutcome {
  const startIndex = args.start_line - 1;
  const endIndex = args.end_line - 1;

  if (args.start_line <= 0) {
    return {
      success: false,
      error: `start_line must be >= 1 (received ${args.start_line}).`,
      note: `${EDIT_FAILED_NOTE_PREFIX} Line numbers must be >= 1.`,
    };
  }

  if (args.end_line < args.start_line) {
    return {
      success: false,
      error: `end_line must be >= start_line (received start ${args.start_line}, end ${args.end_line}).`,
      note: `${EDIT_FAILED_NOTE_PREFIX} The end_line must be >= start_line.`,
    };
  }

  const fileEol = detectFileEol(originalContent);
  const lines = normalizeNewlinesToLF(originalContent).split("\n");

  if (startIndex >= lines.length) {
    return {
      success: false,
      error: `start_line ${args.start_line} exceeds current file length (${lines.length}).`,
      note: `${EDIT_FAILED_NOTE_PREFIX} The file has ${lines.length} lines. ${NOTE_READ_FILE_RETRY}`,
    };
  }

  const clampedEndIndex = Math.min(endIndex, lines.length - 1);
  const currentRange = lines.slice(startIndex, clampedEndIndex + 1);

  if (args.expected_lines && !arraysEqual(currentRange, args.expected_lines)) {
    return {
      success: false,
      error: `expected_lines validation failed. Current lines [${currentRange.join("\n")}] differ from expected [${args.expected_lines.join("\n")}].`,
      note: `${EDIT_FAILED_NOTE_PREFIX} The file content changed since you last read it. ${NOTE_READ_FILE_AGAIN_RETRY}`,
    };
  }

  const before = lines.slice(0, startIndex);
  const after = lines.slice(clampedEndIndex + 1);
  const updatedLines = [...before, ...args.new_lines, ...after];
  const linesReplaced = currentRange.length;
  const totalDelta = args.new_lines.length - currentRange.length;

  return {
    success: true,
    newContent: updatedLines.join(fileEol),
    metadata: {
      edits_applied: 1,
      lines_replaced: linesReplaced,
      line_delta: totalDelta,
    },
  };
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}
