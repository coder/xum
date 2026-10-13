/**
 * How the compaction input trim (trimCompactionInput) sizes one history row.
 *
 * One rule for every row: the row's parts, with every media part and every base64 payload
 * (a data URL, or the data of a part with a mediaType) replaced by a short marker and charged
 * IMAGE_TOKEN_ESTIMATE, the allowance the request-time context check uses (contextBudget.ts).
 * The rest is text: the node counter (compactionInputSizing.ts) counts it with the model's
 * tokenizer, this module's fallback counts chars/4. Tokenizing base64 would charge a screenshot
 * hundreds of thousands of tokens, and chars/4 of a marker would charge it nothing.
 *
 * The caller passes the provider-bound projection of the row (applyToolOutputRedaction), and
 * counts a row again whenever the trim changes it, so no count goes stale.
 */
import { IMAGE_TOKEN_ESTIMATE } from "@/common/constants/contextBudget";
import type { MuxMessage } from "@/common/types/message";
import { RLM_COMPACTION_CHARS_PER_TOKEN } from "@/constants/rlmCompaction";

/** Counts one row's tokens; the trim recounts every row it changes. */
export type CountCompactionRowTokens = (row: MuxMessage) => number | Promise<number>;

export interface CompactionRowSizingInput {
  /** The row's parts with media and base64 payloads replaced by MEDIA_MARKER. */
  projected: unknown;
  /** How many payloads were replaced: each is charged IMAGE_TOKEN_ESTIMATE. */
  mediaParts: number;
}

const MEDIA_MARKER = "[media]";
const DATA_URL = /^data:[^,]*;base64,/i;
// SDK and tool media part types whose payload the provider receives as an attachment.
const MEDIA_PART_TYPES = new Set(["media", "image-data", "file-data", "image-url", "file-url"]);

function isMediaRecord(record: Record<string, unknown>): boolean {
  if (typeof record.type === "string" && MEDIA_PART_TYPES.has(record.type)) return true;
  if (record.type === "image" && "image" in record) return true;
  return (
    record.type === "file" &&
    typeof record.mediaType === "string" &&
    ("url" in record || "data" in record)
  );
}

function projectValue(value: unknown, media: { count: number }): unknown {
  if (typeof value === "string") {
    if (!DATA_URL.test(value)) return value;
    media.count += 1;
    return MEDIA_MARKER;
  }
  if (Array.isArray(value)) return value.map((item) => projectValue(item, media));
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  // Display-only files never reach the provider.
  if (record.type === "display_file") return MEDIA_MARKER;
  if (isMediaRecord(record)) {
    media.count += 1;
    return MEDIA_MARKER;
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, child]) => [key, projectValue(child, media)])
  );
}

export function projectRowForSizing(row: MuxMessage): CompactionRowSizingInput {
  const media = { count: 0 };
  // code_execution's nestedCalls are display-only: convertToModelMessages reads a tool part's
  // input and output only. Counting them made a fitting history look over budget.
  const parts = row.parts.map((part) => {
    if (!("nestedCalls" in part)) return part;
    const { nestedCalls: _nestedCalls, ...rest } = part;
    return rest;
  });
  const projected = projectValue(parts, media);
  return { projected, mediaParts: media.count };
}

/** The fallback count: chars/4 of the projected text, plus the media allowance. */
export function estimateCompactionRowTokens(row: MuxMessage): number {
  const { projected, mediaParts } = projectRowForSizing(row);
  const chars = JSON.stringify(projected).length;
  return Math.ceil(chars / RLM_COMPACTION_CHARS_PER_TOKEN) + mediaParts * IMAGE_TOKEN_ESTIMATE;
}
