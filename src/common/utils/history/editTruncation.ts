import { computeHistoryRangeFingerprint } from "@/common/orpc/onChatCursorFingerprint";
import type { HistoryEditPrecondition } from "@/common/orpc/types";
import { isSyntheticSnapshotUserMessage, type MuxMessage } from "@/common/types/message";
import assert from "@/common/utils/assert";

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
 * Content evidence for an edit, computed over the committed rows a client holds when editing
 * begins (rows with a `historySequence`; streaming placeholders excluded by the caller). The
 * range runs from the truncation target through the newest committed row. Returns `undefined`
 * when the edited message is not among `messages` (the caller cannot fence what it does not
 * hold) — the backend then decides with its own view.
 */
export function buildHistoryEditPrecondition(
  messages: readonly MuxMessage[],
  editMessageId: string
): HistoryEditPrecondition | undefined {
  const committed = messages.filter((message) => message.metadata?.historySequence !== undefined);
  const rangeStartMessageId = getEditTruncateTargetFromMessages(committed, editMessageId);
  if (rangeStartMessageId === undefined) return undefined;
  const rangeStart = committed.find((message) => message.id === rangeStartMessageId);
  assert(rangeStart?.metadata?.historySequence !== undefined, "range start must be committed");
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
