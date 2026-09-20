import type { MuxMessage } from "@/common/types/message";
import assert from "@/common/utils/assert";
import { isNonNegativeInteger } from "@/common/utils/numbers";
import { stableStringify } from "@/common/utils/stableStringify";

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const MISSING_TIMESTAMP = -1;

function updateFnv1a(hash: number, value: string): number {
  let next = hash >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    next ^= value.charCodeAt(index);
    next = Math.imul(next, FNV_PRIME) >>> 0;
  }
  return next >>> 0;
}

/**
 * Build a deterministic fingerprint for persisted history rows strictly older than
 * the provided cursor sequence. Reconnect since-mode uses this to detect deletes/
 * rewrites below the cursor and safely fall back to full replay.
 */
export function computePriorHistoryFingerprint(
  messages: readonly MuxMessage[],
  anchorHistorySequence: number
): string | undefined {
  const priorEntries: Array<{
    id: string;
    historySequence: number;
    timestamp: number;
    role: MuxMessage["role"];
    partsFingerprint: string;
  }> = [];

  for (const message of messages) {
    const historySequence = message.metadata?.historySequence;
    if (historySequence === undefined || historySequence >= anchorHistorySequence) {
      continue;
    }

    priorEntries.push({
      id: message.id,
      historySequence,
      timestamp: message.metadata?.timestamp ?? MISSING_TIMESTAMP,
      role: message.role,
      // Include serialized part content so in-place rewrites that keep id/seq/timestamp
      // still invalidate the fingerprint and force a safe full replay fallback.
      partsFingerprint: JSON.stringify(message.parts),
    });
  }

  if (priorEntries.length === 0) {
    return undefined;
  }

  priorEntries.sort(
    (left, right) => left.historySequence - right.historySequence || left.id.localeCompare(right.id)
  );

  let hash = FNV_OFFSET_BASIS;
  for (const entry of priorEntries) {
    hash = updateFnv1a(
      hash,
      `${entry.historySequence}|${entry.id}|${entry.timestamp}|${entry.role}|${entry.partsFingerprint};`
    );
  }

  return hash.toString(16).padStart(8, "0");
}

/**
 * Normalizes one part for the range fingerprint so a client-assembled row and its persisted
 * form hash identically. Verified against real IPC (tests/ipc/historyFingerprintParity.test.ts):
 * the client stamps part-level `timestamp`s the persisted row drops (and tool parts carry a
 * different one), and object key order differs between the two representations. Everything
 * else — text, reasoning, tool call ids/names/inputs/outputs/states, file parts — round-trips.
 */
function normalizePartForFingerprint(part: MuxMessage["parts"][number]): unknown {
  const { timestamp: _timestamp, ...rest } = part as { timestamp?: number } & Record<
    string,
    unknown
  >;
  return rest;
}

const UNSETTLED_ASSISTANT_PARTS = "<unsettled>";

/**
 * An assistant row whose content is not settled is fenced by identity only (id, sequence,
 * role), not by its parts. The persisted form is the empty placeholder appended before
 * streaming, or a committed partial (`partial: true`); the client's form is the same row with
 * whatever it streamed, also marked `partial`. Their parts legitimately differ — and a stream
 * that failed without usage never persists its text at all — while neither holds content the
 * fence needs to protect. A row the server completed meanwhile is no longer unsettled on its
 * side, so a client still holding the partial version conflicts, as it should.
 *
 * An empty row counts as the placeholder only while it carries no completion metadata: a turn
 * the server finished without parts (refusal, content filter) is stamped `finishReason` /
 * `usage` / `duration` at stream end and is settled — a client still holding the placeholder
 * must conflict with it rather than hash identically.
 */
function isUnsettledAssistantRow(message: MuxMessage): boolean {
  if (message.role !== "assistant") return false;
  if (message.metadata?.partial === true) return true;
  if (message.parts.length !== 0) return false;
  const metadata = message.metadata;
  return (
    metadata?.finishReason === undefined &&
    metadata?.usage === undefined &&
    metadata?.duration === undefined
  );
}

/**
 * Fingerprint of the rows with `fromSequence <= historySequence <= throughSequence` (both
 * inclusive). An edit fences the range it deletes (truncation target through the newest row)
 * with this value: the client computes it over the rows it holds when editing begins and the
 * server recomputes it over the rows it is about to delete, under the history write lock.
 * Rows without a `historySequence` are not evidence on either side.
 *
 * Unlike {@link computePriorHistoryFingerprint} (server-only on both ends), this hash must
 * agree between a client-assembled row and its persisted form, so it covers `historySequence`,
 * `id`, `role` and the key-order-insensitive, timestamp-free projection of `parts` — not
 * `metadata.timestamp`, which the client derives from stream events rather than the row.
 *
 * Returns the row count alongside the hash so a client that is missing a row in the middle of
 * the range (or holds an extra one) is caught explicitly.
 *
 * Rows whose persisted `historySequence` is not a non-negative integer (the wire schema allows
 * any number) are skipped like rows without one: they are self-healed out of sequence
 * accounting everywhere else and must not be evidence on either side.
 */
export function computeHistoryRangeFingerprint(
  messages: readonly MuxMessage[],
  fromSequence: number,
  throughSequence: number
): { rowCount: number; fingerprint: string } {
  assert(isNonNegativeInteger(fromSequence), "fromSequence must be a non-negative integer");
  assert(
    isNonNegativeInteger(throughSequence) && throughSequence >= fromSequence,
    "throughSequence must be an integer >= fromSequence"
  );

  const entries: Array<{
    id: string;
    historySequence: number;
    role: MuxMessage["role"];
    partsFingerprint: string;
  }> = [];

  for (const message of messages) {
    const historySequence = message.metadata?.historySequence;
    if (
      !isNonNegativeInteger(historySequence) ||
      historySequence < fromSequence ||
      historySequence > throughSequence
    ) {
      continue;
    }
    entries.push({
      id: message.id,
      historySequence,
      role: message.role,
      partsFingerprint: isUnsettledAssistantRow(message)
        ? UNSETTLED_ASSISTANT_PARTS
        : stableStringify(message.parts.map(normalizePartForFingerprint)),
    });
  }

  entries.sort(
    (left, right) => left.historySequence - right.historySequence || left.id.localeCompare(right.id)
  );

  let hash = FNV_OFFSET_BASIS;
  for (const entry of entries) {
    hash = updateFnv1a(
      hash,
      `${entry.historySequence}|${entry.id}|${entry.role}|${entry.partsFingerprint};`
    );
  }

  return { rowCount: entries.length, fingerprint: hash.toString(16).padStart(8, "0") };
}
