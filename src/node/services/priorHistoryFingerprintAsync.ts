import {
  FNV_OFFSET_BASIS,
  MISSING_TIMESTAMP,
  updateFnv1a,
} from "@/common/orpc/onChatCursorFingerprint";
import type { MuxMessage } from "@/common/types/message";
import { EventLoopYielder } from "@/node/utils/concurrency/eventLoopYielder";

interface PriorHistoryRow {
  historySequence: number;
  message: MuxMessage;
}

function comparePriorHistoryRows(left: PriorHistoryRow, right: PriorHistoryRow): number {
  return (
    left.historySequence - right.historySequence || left.message.id.localeCompare(right.message.id)
  );
}

/**
 * Non-blocking twin of computePriorHistoryFingerprint (the reference, which must return the same
 * value for every input). The synchronous version serializes and hashes every prior row in one
 * block, 2+ s on a 1.24M-row epoch, which stalls heartbeats, IPC and other workspaces' replays
 * (#4655). This one:
 * - yields to the event loop while collecting and while hashing rows;
 * - skips the sort when rows are already in comparator order (the normal case: history is
 *   stored in sequence order), because sorting 1.24M entries is itself a long block. Skipping is
 *   exact only for a consistent comparator: Array.prototype.sort is stable, so sorting an array
 *   whose adjacent pairs all compare <= 0 leaves it unchanged. A sequence that is not a finite
 *   number (persisted metadata is not schema-checked on read, so NaN, Infinity or a string can
 *   appear) makes the subtraction NaN, which `||` turns into the id tiebreak, and the comparator
 *   stops being consistent: adjacent pairs can look ordered while the reference's sort still
 *   moves rows. Such histories, and any unordered one, sort exactly like the reference, on the
 *   same rows in the same input order;
 * - serializes parts only while hashing and feeds FNV-1a the entry's pieces in order instead of
 *   one concatenated string (FNV-1a streams UTF-16 code units, so the hash is identical), so it
 *   never holds every row's serialized parts at once.
 *
 * Callers must not mutate `messages` until the promise settles.
 */
export async function computePriorHistoryFingerprintAsync(
  messages: readonly MuxMessage[],
  anchorHistorySequence: number
): Promise<string | undefined> {
  const yielder = new EventLoopYielder();
  const rows: PriorHistoryRow[] = [];
  let inComparatorOrder = true;

  for (let index = 0; index < messages.length; index += 1) {
    // Each row here costs a few property reads, so a clock read per row would dominate this
    // loop (1M rows, bun: ~40 ms vs ~8 ms). Checking every 1024 rows stays far inside the budget.
    if ((index & 1023) === 0 && yielder.isDue()) await yielder.yield();
    const message = messages[index];
    const historySequence = message.metadata?.historySequence;
    // Same filter as the reference, deliberately not isNonNegativeInteger: any change here
    // changes which rows the cursor fingerprint covers.
    if (historySequence === undefined || historySequence >= anchorHistorySequence) {
      continue;
    }
    const row = { historySequence, message };
    // Number.isFinite does not coerce, so it also rejects a persisted string sequence.
    if (
      !Number.isFinite(historySequence) ||
      (rows.length > 0 && !(comparePriorHistoryRows(rows[rows.length - 1], row) <= 0))
    ) {
      inComparatorOrder = false;
    }
    rows.push(row);
  }

  if (rows.length === 0) {
    return undefined;
  }

  if (!inComparatorOrder) {
    rows.sort(comparePriorHistoryRows);
  }

  let hash = FNV_OFFSET_BASIS;
  for (const { historySequence, message } of rows) {
    if (yielder.isDue()) await yielder.yield();
    const timestamp = message.metadata?.timestamp ?? MISSING_TIMESTAMP;
    // Pieces of the reference's `${seq}|${id}|${timestamp}|${role}|${parts};` in order.
    hash = updateFnv1a(hash, `${historySequence}|${message.id}|${timestamp}|${message.role}|`);
    // Template, like the reference: a malformed persisted row without `parts` makes
    // JSON.stringify return undefined, which the reference hashes as "undefined".
    hash = updateFnv1a(hash, `${JSON.stringify(message.parts)}`);
    hash = updateFnv1a(hash, ";");
  }

  return hash.toString(16).padStart(8, "0");
}
