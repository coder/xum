import { computeHistoryRangeFingerprint } from "@/common/orpc/onChatCursorFingerprint";
import type { HistoryEditPrecondition } from "@/common/orpc/types";
import { isSyntheticSnapshotUserMessage, type MuxMessage } from "@/common/types/message";
import { isPlanReviewRecordMessage } from "@/common/utils/planReview/planReviewEnvelope";
import assert from "@/common/utils/assert";
import { isNonNegativeInteger } from "@/common/utils/numbers";

/**
 * The row an edit truncates from: the edited message itself, or the first of the synthetic
 * snapshot rows (file @-mentions, skills, MCP prompts) persisted immediately before it. Those
 * snapshots belong to the edited turn and are re-captured by the replacement send, so they are
 * deleted together with it.
 *
 * Shared by the backend (which applies the truncation) and the client (which fences an edit
 * with content evidence of exactly this range), so both sides agree on the range start.
 * Returns `undefined` when the edited message is not in `messages`.
 */
export function getEditTruncateTargetFromMessages(
  messages: readonly MuxMessage[],
  editMessageId: string
): string | undefined {
  const editIndex = messages.findIndex((message) => message.id === editMessageId);
  if (editIndex === -1) {
    return undefined;
  }

  let truncateTargetId = editMessageId;
  for (let i = editIndex - 1; i >= 0; i -= 1) {
    const message = messages[i];
    // Only this turn's own prelude snapshots (file @-mentions, skills, MCP prompts) are cut
    // with the edit. Plan-review records are hidden rows too, but independent durable
    // mutations (a resolve/reopen while idle, an on-demand snapshot): cutting one would silently
    // undo the user's review state, so the walk stops at them.
    if (!isSyntheticSnapshotUserMessage(message) || isPlanReviewRecordMessage(message)) {
      break;
    }
    truncateTargetId = message.id;
  }

  return truncateTargetId;
}

/**
 * Content evidence for an edit over the wire rows a client holds when editing begins. The
 * truncation target is derived over EVERY row (a row with a malformed `historySequence` still
 * separates a snapshot from the edited message, exactly as it does for the backend's cut);
 * the range then covers only committed rows — rows with a valid `historySequence` (a missing
 * or malformed one the wire schema still admits is not evidence; see
 * computeHistoryRangeFingerprint) — from the first committed row at or after the target
 * through the newest committed row. A snapshot with a malformed sequence directly before the
 * edited message is therefore cut without being evidence, like a wire-unparseable one.
 * Returns `undefined` when the edited message is not held or nothing committed remains from
 * the target on: the caller cannot fence what it does not hold.
 *
 * The backend verifies an edit by building the same evidence over its own wire projection of
 * history and comparing field by field, so both sides agree by construction.
 */
export function buildHistoryEditPrecondition(
  messages: readonly MuxMessage[],
  editMessageId: string
): HistoryEditPrecondition | undefined {
  const truncateTargetId = getEditTruncateTargetFromMessages(messages, editMessageId);
  if (truncateTargetId === undefined) return undefined;
  const targetIndex = messages.findIndex((message) => message.id === truncateTargetId);
  assert(targetIndex !== -1, "the truncation target is one of the rows");
  const isCommitted = (message: MuxMessage) =>
    isNonNegativeInteger(message.metadata?.historySequence);
  const committed = messages.filter(isCommitted);
  const rangeStart = messages.slice(targetIndex).find(isCommitted);
  if (rangeStart === undefined) return undefined;
  const rangeStartMessageId = rangeStart.id;
  assert(isNonNegativeInteger(rangeStart.metadata?.historySequence), "range start is committed");
  let newest = rangeStart;
  for (const message of committed) {
    if (message.metadata!.historySequence! > newest.metadata!.historySequence!) newest = message;
  }
  const rangeStartHistorySequence = rangeStart.metadata.historySequence;
  const newestHistorySequence = newest.metadata!.historySequence!;
  const range = computeHistoryRangeFingerprint(
    committed,
    rangeStartHistorySequence,
    newestHistorySequence
  );
  assert(range.rowCount > 0, "the edited row itself is always in range");
  return {
    editMessageId,
    rangeStartMessageId,
    rangeStartHistorySequence,
    newestMessageId: newest.id,
    newestHistorySequence,
    rangeRowCount: range.rowCount,
    rangeFingerprint: range.fingerprint,
  };
}
