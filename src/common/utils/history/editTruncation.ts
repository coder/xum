import { computeHistoryRangeFingerprint } from "@/common/orpc/onChatCursorFingerprint";
import type { HistoryEditPrecondition } from "@/common/orpc/types";
import { isSyntheticSnapshotUserMessage, type MuxMessage } from "@/common/types/message";
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
    if (!isSyntheticSnapshotUserMessage(message)) {
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
 * the fingerprint, newest row and row count then cover only committed rows — rows with a valid
 * `historySequence` (a missing or malformed one the wire schema still admits is not evidence;
 * see computeHistoryRangeFingerprint). The range runs from the truncation target through the
 * newest committed row. Returns `undefined` when the edited message is not held or the range
 * start is not committed: the caller cannot fence what it does not hold.
 *
 * The backend verifies an edit by building the same evidence over its own wire projection of
 * history and comparing field by field, so both sides agree by construction.
 */
export function buildHistoryEditPrecondition(
  messages: readonly MuxMessage[],
  editMessageId: string
): HistoryEditPrecondition | undefined {
  const rangeStartMessageId = getEditTruncateTargetFromMessages(messages, editMessageId);
  if (rangeStartMessageId === undefined) return undefined;
  const committed = messages.filter((message) =>
    isNonNegativeInteger(message.metadata?.historySequence)
  );
  const rangeStart = committed.find((message) => message.id === rangeStartMessageId);
  if (rangeStart === undefined) return undefined;
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
