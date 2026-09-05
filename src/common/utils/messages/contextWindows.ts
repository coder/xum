import { isRolloverBoundary, type MuxMessage } from "@/common/types/message";
import { getContextBoundaryKind, isDurableContextBoundaryMarker } from "./compactionBoundary";

export function getHistoryItemId(message: MuxMessage): string {
  const sequence = message.metadata?.historySequence;
  return Number.isSafeInteger(sequence) && sequence! >= 0 ? String(sequence) : `m:${message.id}`;
}
export function getContextWindowId(message?: MuxMessage): string {
  return message && isDurableContextBoundaryMarker(message)
    ? `w:${getHistoryItemId(message)}`
    : "w:0";
}
export function isManualHistoryReset(message: MuxMessage): boolean {
  return getContextBoundaryKind(message) === "reset" && !isRolloverBoundary(message);
}
