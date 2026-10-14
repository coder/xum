/**
 * Preserved thinking: with the `thinking-binding-controls` beta, Anthropic reports every
 * replayed thinking block it dropped (or let through despite a failed prefix check) in
 * `input_transformations`. This module is the one reader of that field:
 * - DevTools stores the sanitized entries per step (readInputTransformations on raw
 *   events, sanitizeInputTransformations on persisted rows) and keeps unknown types.
 * - The backend log counts recognized entries by reason (countAnthropicInputTransformations
 *   on the SDK's `providerMetadata.anthropic.inputTransformations`), without logging
 *   paths, signatures or prompt text.
 */
import type { AnthropicInputTransformation } from "@/common/types/devtools";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Keep only well-formed entries, copying the known fields. Copying (instead of
 * passing objects through) keeps unexpected extra fields out of devtools.jsonl.
 * Unknown types and reasons are kept. Returns null when the value is not an array.
 */
export function sanitizeInputTransformations(
  value: unknown
): AnthropicInputTransformation[] | null {
  if (!Array.isArray(value)) return null;
  return value.flatMap((entry): AnthropicInputTransformation[] => {
    if (!isRecord(entry) || typeof entry.type !== "string" || typeof entry.path !== "string") {
      return [];
    }
    return [
      {
        type: entry.type,
        path: entry.path,
        ...(typeof entry.reason === "string" ? { reason: entry.reason } : {}),
      },
    ];
  });
}

/** The `input_transformations` an Anthropic event or response body carries, if any. */
function transformationsOf(event: unknown): unknown {
  if (!isRecord(event)) return undefined;
  switch (event.type) {
    // Streaming: the first report arrives on message_start.message.
    case "message_start":
      return isRecord(event.message) ? event.message.input_transformations : undefined;
    // Streaming: after a mid-stream server-side fallback, the final message_delta
    // reports again with the serving model's entries. "message" is the
    // non-streaming response body.
    case "message_delta":
    case "message":
      return event.input_transformations;
    default:
      return undefined;
  }
}

/**
 * Read Anthropic `input_transformations` from one step's raw stream events, or from
 * `[responseBody]` for a generate call. Later reports win: the final message_delta
 * after a server-side fallback replaces message_start's value. The AI SDK's
 * providerMetadata keeps only the last value per step too, but raw events are what
 * DevTools already records. Events from other providers never match.
 * Returns null when no event reported the field, [] when it was reported empty.
 */
export function readInputTransformations(
  events: readonly unknown[] | null | undefined
): AnthropicInputTransformation[] | null {
  let latest: AnthropicInputTransformation[] | null = null;
  for (const event of events ?? []) {
    const sanitized = sanitizeInputTransformations(transformationsOf(event));
    if (sanitized !== null) latest = sanitized;
  }
  return latest;
}

const DROPPED_REASONS = [
  "prefix_binding_mismatch",
  "model_binding_mismatch",
  "organization_binding_mismatch",
] as const;

type DroppedReason = (typeof DROPPED_REASONS)[number];

export interface AnthropicInputTransformationCounts {
  /** `thinking_dropped` entries by reason. */
  dropped: Record<DroppedReason, number>;
  /** `thinking_mismatch_allowed` entries (always `prefix_binding_mismatch`). */
  mismatchAllowed: number;
}

function isDroppedReason(reason: unknown): reason is DroppedReason {
  return DROPPED_REASONS.some((known) => known === reason);
}

/**
 * Counts recognized `input_transformations` entries in one step's provider metadata.
 * Returns null when there are none. Unknown types and reasons are ignored, as the API
 * docs ask: later checks add values.
 */
export function countAnthropicInputTransformations(
  providerMetadata: Record<string, unknown> | undefined
): AnthropicInputTransformationCounts | null {
  const anthropic = providerMetadata?.anthropic;
  const entries = sanitizeInputTransformations(
    isRecord(anthropic) ? anthropic.inputTransformations : undefined
  );
  if (entries === null) return null;

  const counts: AnthropicInputTransformationCounts = {
    dropped: {
      prefix_binding_mismatch: 0,
      model_binding_mismatch: 0,
      organization_binding_mismatch: 0,
    },
    mismatchAllowed: 0,
  };
  let total = 0;
  for (const { type, reason } of entries) {
    if (type === "thinking_dropped" && isDroppedReason(reason)) {
      counts.dropped[reason] += 1;
      total += 1;
    } else if (type === "thinking_mismatch_allowed" && reason === "prefix_binding_mismatch") {
      counts.mismatchAllowed += 1;
      total += 1;
    }
  }
  return total > 0 ? counts : null;
}
