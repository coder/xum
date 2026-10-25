import type { MuxMessage } from "@/common/types/message";
import { isPlanReviewRecordMessage } from "@/common/utils/planReview/planReviewEnvelope";
import { isWorkflowDisplayOnlyMessage } from "@/common/utils/workflowRunMessages";

/**
 * Durable history rows that exist for the UI only and must never reach a provider request —
 * neither directly (turnContextAssembler.keepContextRow) nor as a compaction keep-recent tail
 * copy (compactionHandler.buildPreservedTailCopies). One predicate so a new hidden row kind is
 * excluded from both paths at once.
 */
export function isModelHiddenMessage(message: MuxMessage): boolean {
  return isWorkflowDisplayOnlyMessage(message) || isPlanReviewRecordMessage(message);
}
