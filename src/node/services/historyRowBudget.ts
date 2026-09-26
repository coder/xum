import assert from "@/common/utils/assert";
import {
  COMPACTION_BOUNDARY_ROW_HEADROOM_BYTES,
  MIN_FITTED_COMPACTION_SUMMARY_BYTES,
  SESSION_HISTORY_MAX_LINE_BYTES,
} from "@/common/constants/contextBudget";
import type { MuxMessage } from "@/common/types/message";

/**
 * Size of `message` as HistoryService would persist it: message + workspaceId, with a
 * widest-case sequence stamp. Record text is JSON-escaped once in the envelope and again in the
 * JSONL row, so content under a raw cap (quotes, backslashes, control characters) can still
 * exceed the row limit — and the provider/replacement-row scanners treat such a row as an
 * unreadable run, so it must be refused before it is written.
 */
export function measurePersistedHistoryRowBytes(message: MuxMessage, workspaceId: string): number {
  return Buffer.byteLength(
    JSON.stringify({
      ...message,
      workspaceId,
      metadata: { ...message.metadata, historySequence: Number.MAX_SAFE_INTEGER },
    }),
    "utf8"
  );
}

/** Appended to a cut summary so the model and the user both see that it is incomplete. */
export function formatCompactionSummaryTruncationMarker(
  keptBytes: number,
  originalBytes: number
): string {
  return `\n\n[Summary truncated: kept ${keptBytes} of ${originalBytes} bytes to fit the chat history row limit.]`;
}

export interface FittedCompactionSummary {
  message: MuxMessage;
  /** Raw UTF-8 byte counts of the summary text, set only when the text was cut. */
  truncated?: { originalBytes: number; keptBytes: number };
  /** The row is still over SESSION_HISTORY_MAX_LINE_BYTES because of its non-summary fields. */
  rowExceedsLimit: boolean;
  rowBytes: number;
}

/** Bytes a string adds to a JSON row: its escaped UTF-8 form without the two quotes. */
function escapedStringBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text), "utf8") - 2;
}

/**
 * Bound a compaction boundary's model summary so the boundary row stays readable by history
 * scanners, which skip rows over SESSION_HISTORY_MAX_LINE_BYTES (#4551). Only the summary text is
 * cut; the pending follow-up and all metadata are kept exactly as given.
 *
 * - Row within the limit (less headroom): returned unchanged, same object.
 * - The non-summary fields leave at least MIN_FITTED_COMPACTION_SUMMARY_BYTES: the summary is cut
 *   to exactly what is left, so the row fits.
 * - Otherwise (a large pending follow-up, typically inline attachments): cutting the summary
 *   cannot make the row fit, so the summary is only capped at the row budget on its own and the
 *   row stays oversized. Readers must then recognize the oversized boundary themselves.
 *
 * A cut keeps an exact prefix (never splitting a surrogate pair) and appends an explicit marker.
 * Sizes are measured with JSON.stringify, the same serializer HistoryService writes with.
 */
export function fitCompactionSummaryToHistoryRow(
  message: MuxMessage,
  workspaceId: string
): FittedCompactionSummary {
  const textIndex = message.parts.findIndex((part) => part.type === "text");
  const textParts = message.parts.filter((part) => part.type === "text");
  assert(textParts.length === 1, "Compaction boundary summaries carry exactly one text part");
  const summaryPart = message.parts[textIndex];
  assert(summaryPart?.type === "text", "Compaction boundary summary part must be text");

  const limit = SESSION_HISTORY_MAX_LINE_BYTES - COMPACTION_BOUNDARY_ROW_HEADROOM_BYTES;
  const rowBytes = measurePersistedHistoryRowBytes(message, workspaceId);
  if (rowBytes <= limit) return { message, rowExceedsLimit: false, rowBytes };

  const withSummary = (text: string): MuxMessage => ({
    ...message,
    parts: message.parts.map((part, index) =>
      index === textIndex ? { ...summaryPart, text } : part
    ),
  });
  const summary = summaryPart.text;
  const baseBytes = measurePersistedHistoryRowBytes(withSummary(""), workspaceId);
  const budget =
    baseBytes + MIN_FITTED_COMPACTION_SUMMARY_BYTES <= limit ? limit - baseBytes : limit;
  if (escapedStringBytes(summary) <= budget) {
    // Only reachable when the follow-up leaves no useful room: the summary is not the problem.
    return { message, rowExceedsLimit: rowBytes > SESSION_HISTORY_MAX_LINE_BYTES, rowBytes };
  }

  const originalBytes = Buffer.byteLength(summary, "utf8");
  // Reserve the widest marker: kept bytes never have more digits than the original count.
  const prefixBudget =
    budget -
    escapedStringBytes(formatCompactionSummaryTruncationMarker(originalBytes, originalBytes));
  assert(prefixBudget > 0, "Compaction summary budget must leave room beyond the marker");
  // Longest prefix whose escaped size fits; escaped size grows monotonically with length.
  let low = 0;
  let high = summary.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (escapedStringBytes(summary.slice(0, middle)) <= prefixBudget) low = middle;
    else high = middle - 1;
  }
  const lastCode = summary.charCodeAt(low - 1);
  if (low > 0 && lastCode >= 0xd800 && lastCode <= 0xdbff) low -= 1;
  const kept = summary.slice(0, low);
  const keptBytes = Buffer.byteLength(kept, "utf8");
  const text = kept + formatCompactionSummaryTruncationMarker(keptBytes, originalBytes);
  assert(escapedStringBytes(text) <= budget, "Truncated compaction summary must fit its budget");

  const fitted = withSummary(text);
  assert(fitted.metadata === message.metadata, "Summary truncation must not touch row metadata");
  const fittedRowBytes = measurePersistedHistoryRowBytes(fitted, workspaceId);
  return {
    message: fitted,
    truncated: { originalBytes, keptBytes },
    rowExceedsLimit: fittedRowBytes > SESSION_HISTORY_MAX_LINE_BYTES,
    rowBytes: fittedRowBytes,
  };
}
