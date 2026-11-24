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

const MAX_WHITESPACE_HINT_TOKENS = 200;

/**
 * The agent-note hint for a search string that is missing from the file only because its
 * whitespace differs (#2732): tabs vs spaces, trailing spaces or line breaks. It names the
 * 1-based line where the whitespace-insensitive match starts, so the model can copy the exact
 * text. The edit itself stays exact: the hint never applies the near match.
 */
export function whitespaceMismatchHint(content: string, needle: string): string | undefined {
  // Without whitespace the needle is a literal that the exact search already missed.
  if (!/\s/u.test(needle) || needle.trim() === "") return undefined;
  const tokens = needle.trim().split(/\s+/u);
  // The search costs about file length x token count on a failed edit, so a huge needle gets the
  // generic note instead of a slow (or stack-overflowing) regex.
  if (tokens.length > MAX_WHITESPACE_HINT_TOKENS) return undefined;
  // Each whitespace run in the needle may be any whitespace (or none) in the file. Tokens hold
  // no whitespace, so no two `\s*` are adjacent.
  const pattern = new RegExp(tokens.map(escapeRegExp).join("\\s*"), "gu");
  const match = pattern.exec(content);
  // Two near matches: naming the first could send the retry to the wrong block.
  if (match === null || pattern.exec(content) !== null) return undefined;
  const line = content.slice(0, match.index).split("\n").length;
  return `It matches the text at line ${line} only when whitespace is ignored: the indentation (tabs vs spaces), trailing spaces or line breaks differ. Read the file around line ${line}, copy its exact whitespace, then retry.`;
}

function oldStringNotFoundNote(content: string, oldString: string): string {
  const next = whitespaceMismatchHint(content, oldString) ?? NOTE_READ_FILE_FIRST_RETRY;
  return `${EDIT_FAILED_NOTE_PREFIX} The old_string does not exist in the file. ${next}`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

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
      note: oldStringNotFoundNote(originalContent, args.old_string),
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
