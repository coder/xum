/**
 * Shared implementation for file edit replace tools
 *
 * These helpers are used by both string-based and line-based replace tools,
 * providing the core logic while keeping the tool definitions simple for AI providers.
 */

import {
  EDIT_FAILED_NOTE_PREFIX,
  NOTE_READ_FILE_FIRST_RETRY,
  type FileEditReplaceStringToolArgs,
} from "@/common/types/tools";

import { convertNewlines, detectFileEol } from "./eol";

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
// Local code previously imported StringReplaceArgs from this module.
export type StringReplaceArgs = FileEditReplaceStringToolArgs;

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
