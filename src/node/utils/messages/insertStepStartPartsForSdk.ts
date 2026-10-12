import type { StepStartUIPart } from "ai";

import type { MuxMessage } from "@/common/types/message";

/** A MuxMessage whose assistant parts may carry the SDK's request-only step boundaries. */
export type MuxMessageWithStepStarts = Omit<MuxMessage, "parts"> & {
  parts: Array<MuxMessage["parts"][number] | StepStartUIPart>;
};

/**
 * Indices this helper can trust: safe integers in strictly ascending order that start at 0.
 * Every producer seeds the list with 0 (the first step), so a list without it is corrupted.
 */
function isTrustedStepStartList(indices: unknown): indices is number[] {
  return (
    Array.isArray(indices) &&
    indices[0] === 0 &&
    indices.every(
      (index: unknown, position) =>
        typeof index === "number" &&
        Number.isSafeInteger(index) &&
        index >= 0 &&
        (position === 0 || index > (indices[position - 1] as number))
    )
  );
}

/**
 * Request-only: put a `step-start` part before every later step of an assistant row, at the
 * persisted `metadata.stepStartPartIndices`.
 *
 * Why: inside a turn, each streamText step sends the previous steps as one assistant message
 * plus one tool message per step. The next turn rebuilds the same steps from chat.jsonl, and
 * convertToModelMessages starts a new assistant message only at a `step-start` part, which
 * StreamManager does not persist. splitMixedContentMessages later splits where text or
 * reasoning follows a tool call, but a step that opens with a tool call stayed folded into the
 * previous step: two sequential calls replayed as one parallel call, so the rebuilt request
 * stopped repeating the bytes the previous turn sent and missed the prompt cache from there.
 *
 * Applied for every provider: every provider's in-turn steps used this split, so the rebuild
 * now matches what each provider already accepted. Rows without indices, or with indices that
 * are not strictly ascending integers starting at 0 (corrupted history), keep the old shape.
 * Indices outside the row's parts are skipped, and 0 needs no boundary.
 */
export function insertStepStartPartsForSdk(messages: MuxMessage[]): MuxMessageWithStepStarts[] {
  return messages.map((message) => {
    if (message.role !== "assistant") return message;
    const indices: unknown = message.metadata?.stepStartPartIndices;
    if (!isTrustedStepStartList(indices)) return message;
    const starts = new Set(indices.filter((index) => index > 0 && index < message.parts.length));
    if (starts.size === 0) return message;
    return {
      ...message,
      parts: message.parts.flatMap((part, index) =>
        starts.has(index) ? [{ type: "step-start" as const }, part] : [part]
      ),
    };
  });
}
