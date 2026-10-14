import type { ModelMessage } from "ai";

import type { MuxMessage, MuxMetadata } from "@/common/types/message";
import { findLatestContextBoundaryIndex } from "@/common/utils/messages/compactionBoundary";
import { isTrustedStepStartList } from "./insertStepStartPartsForSdk";
import { stripReasoningReplay } from "./reasoningProviderOptions";

/** Where a receipt's strip ends (MuxMetadata.anthropicThinkingReplayFromStep). */
export type AnthropicThinkingReplayPoint = NonNullable<
  MuxMetadata["anthropicThinkingReplayFromStep"]
>;

/**
 * The point that covers both strips. A later strip in the same row only moves the point
 * forward: it removed everything the earlier one did. "end" (server tool) covers every step.
 */
export function laterAnthropicThinkingReplayPoint(
  current: AnthropicThinkingReplayPoint | undefined,
  next: AnthropicThinkingReplayPoint
): AnthropicThinkingReplayPoint {
  if (current === "end" || next === "end") return "end";
  return current === undefined ? next : Math.max(current, next);
}

/**
 * Request-only marker on reasoning parts the receipt strips. convertToModelMessages copies a
 * UI part's providerMetadata into providerOptions, and coalescing merges namespaces, so the
 * marker reaches the merged block. stripMarkedAnthropicThinking removes every marked part.
 */
const STRIP_MARKER = "stripThinkingReplay";

/** The receipt's point, or undefined for an old receipt or a corrupted value. */
function readReplayPoint(receipt: MuxMessage): AnthropicThinkingReplayPoint | undefined {
  const point: unknown = receipt.metadata?.anthropicThinkingReplayFromStep;
  if (point === "end") return point;
  return typeof point === "number" && Number.isSafeInteger(point) && point >= 0 ? point : undefined;
}

/**
 * The first part index of the receipt row whose Anthropic thinking replays, or undefined
 * when the whole segment must lose it (old receipts, corrupted points, or a step point
 * without trusted step boundaries).
 */
function keptFromPartIndex(receipt: MuxMessage): number | undefined {
  const point = readReplayPoint(receipt);
  if (point === undefined || point === 0) return point;
  if (point === "end") return Number.POSITIVE_INFINITY;
  const starts: unknown = receipt.metadata?.stepStartPartIndices;
  if (!isTrustedStepStartList(starts)) return undefined;
  // Persisted boundaries drop starts at or past the row's last part (a step that produced
  // nothing), so a point past the list means the strip came after every part of the row.
  return point < starts.length ? starts[point] : Number.POSITIVE_INFINITY;
}

/** The segment's latest receipt row and the IDs of the segment rows after it. */
function findLatestReceipt(
  receiptRows: MuxMessage[]
): { receipt: MuxMessage; laterIds: Set<string> } | null {
  const segment = receiptRows.slice(findLatestContextBoundaryIndex(receiptRows) + 1);
  const index = segment.findLastIndex(
    (row) => row.role === "assistant" && row.metadata?.anthropicThinkingReplay === "off"
  );
  if (index < 0) return null;
  return {
    receipt: segment[index],
    laterIds: new Set(segment.slice(index + 1).map((row) => row.id)),
  };
}

function markRow(message: MuxMessage, keptFrom: number): MuxMessage {
  if (message.role !== "assistant" || keptFrom <= 0) return message;
  let changed = false;
  const parts = message.parts.map((part, index) => {
    if (index >= keptFrom || part.type !== "reasoning") return part;
    // attachReasoningReplayMetadata already mirrored the replay data here. Only parts that
    // carry Anthropic replay data reach the provider, so only they need the marker.
    const metadata = (part as { providerMetadata?: Record<string, Record<string, unknown>> })
      .providerMetadata;
    if (metadata?.anthropic == null) return part;
    changed = true;
    return { ...part, providerMetadata: { ...metadata, mux: { [STRIP_MARKER]: true } } };
  });
  return changed ? { ...message, parts } : message;
}

/**
 * Preserved thinking: which Anthropic thinking a receipt keeps out of the request.
 *
 * Rule for every prompt-cache fix: the next turn's rebuild sends the bytes the turn sent. The
 * latest receipt of the segment decides. Its row's steps before the point and every row before
 * it lose their thinking (the turn's requests sent them without it), the rest keeps it (the
 * turn kept sending it, and its later blocks are bound to it). Before this point existed, a
 * receipt stripped the whole segment, which rewrote every later turn's tail (#5086 notes the
 * in-turn side: blocks after an in-turn strip keep replaying, #5279).
 *
 * Downgrade: an older build ignores the point and strips the whole segment, and its later
 * rows are bound to that. Back on this build, those rows' thinking replays after the receipt
 * row's kept steps, which costs one 400 and one signature repair; the repair's receipt then
 * holds again.
 *
 * Returns null without a receipt, "all" when the whole segment loses its Anthropic thinking,
 * or the rows with the parts to strip marked.
 */
function markAnthropicThinkingStrip(
  messages: MuxMessage[],
  receiptRows: MuxMessage[]
): MuxMessage[] | "all" | null {
  const latest = findLatestReceipt(receiptRows);
  if (latest === null) return null;
  const { receipt, laterIds } = latest;
  const keptFrom = keptFromPartIndex(receipt);
  if (keptFrom === undefined) return "all";
  // A request that edited the row (compaction input trim) moved the part indices.
  const sentReceipt = messages.find((message) => message.id === receipt.id);
  if (sentReceipt != null && sentReceipt.parts.length !== receipt.parts.length) return "all";

  // The repair of a turn with no output leaves an empty receipt row that request building
  // filters out (#5886), so the rows after it also mark where the kept region starts.
  let beforeReceipt = true;
  return messages.map((message) => {
    if (message.id === receipt.id) {
      beforeReceipt = false;
      return markRow(message, keptFrom);
    }
    beforeReceipt &&= !laterIds.has(message.id);
    return beforeReceipt ? markRow(message, Number.POSITIVE_INFINITY) : message;
  });
}

/** Remove the Anthropic thinking markAnthropicThinkingStrip marked (same rules as the repair). */
function stripMarkedAnthropicThinking(messages: ModelMessage[]): ModelMessage[] {
  return stripReasoningReplay(
    messages,
    "anthropic",
    (part) => part.providerOptions?.mux?.[STRIP_MARKER] === true
  );
}

export interface AnthropicThinkingStripPlan {
  /** The rows to convert, with the parts the receipt strips marked. */
  messages: MuxMessage[];
  /** Run on the converted request, after the provider transforms. */
  strip: (messages: ModelMessage[]) => ModelMessage[];
}

/**
 * The receipt's strip for one request (see markAnthropicThinkingStrip). Plan it after
 * attachReasoningReplayMetadata and before step-start insertion, while part indices still
 * match the persisted step boundaries. "all" uses the one-request repair's strip
 * (stripReasoningReplay), which also covers adaptive thinking, where transformModelMessages
 * ignores anthropicStripReasoning.
 */
export function planAnthropicThinkingStrip(
  provider: string,
  messages: MuxMessage[],
  receiptRows: MuxMessage[]
): AnthropicThinkingStripPlan {
  const marked =
    provider === "anthropic" ? markAnthropicThinkingStrip(messages, receiptRows) : null;
  if (marked === null) return { messages, strip: (request) => request };
  if (marked === "all") {
    return { messages, strip: (request) => stripReasoningReplay(request, "anthropic") };
  }
  return { messages: marked, strip: stripMarkedAnthropicThinking };
}
