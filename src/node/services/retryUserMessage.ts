// Which user row an automatic retry resumes. AgentSession's auto-retry and startup recovery
// replay this row, and WorkspaceTurnManager reads the same row to tell whether a turn can still
// be resumed, so both sides must select it here.
import {
  getCompactionFollowUpContent,
  isContextBudgetWarningMessage,
  isSyntheticSnapshotUserMessage,
  parseWorkspaceTurnTaskCorrelation,
  type MuxMessage,
  type WorkspaceTurnTaskCorrelation,
} from "@/common/types/message";
import { parseSubagentReportEnvelope } from "@/common/utils/subagentReportEnvelope";
import { isCompactionRequestMetadata } from "./contextManagement/compactionRequests";

export function isSyntheticGoalPauseBoundaryMessage(message: MuxMessage): boolean {
  return (
    message.role === "user" &&
    message.metadata?.synthetic === true &&
    message.metadata.muxMetadata?.type === "goal-pause-boundary"
  );
}

export function isVisibleCompletedSubagentReportMessage(message: MuxMessage): boolean {
  if (
    message.role !== "user" ||
    message.metadata?.synthetic !== true ||
    message.metadata.uiVisible !== true
  ) {
    return false;
  }
  const text = message.parts
    .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  return parseSubagentReportEnvelope(text)?.status === "completed";
}

/** Rejected rows terminate retry lookup, including empty assistant capsules from newer builds. */
export function findLastRetryUserMessage(messages: MuxMessage[]): MuxMessage | undefined {
  return messages.findLast(
    (message) =>
      Boolean(message.metadata?.contextBudgetRejected) || shouldUseUserMessageForRetry(message)
  );
}

/** Rows a retry never replays. */
const NEVER_RETRIED: ReadonlyArray<(message: MuxMessage) => boolean> = [
  isVisibleCompletedSubagentReportMessage,
  isSyntheticGoalPauseBoundaryMessage,
  isSyntheticSnapshotUserMessage,
  isContextBudgetWarningMessage,
];

// Include UI-visible synthetic rows (e.g., crash-recovered compaction follow-ups)
// so retries continue the most recent pending user intent.
function isRetriedSyntheticMessage(message: MuxMessage): boolean {
  return (
    message.metadata?.uiVisible === true ||
    message.metadata?.muxMetadata?.contextBudgetContinuation === true ||
    isCompactionRequestMetadata(message.metadata?.muxMetadata)
  );
}

export function shouldUseUserMessageForRetry(message: MuxMessage): boolean {
  if (message.role !== "user" || message.metadata?.contextBudgetRejected) {
    return false;
  }
  if (NEVER_RETRIED.some((neverRetried) => neverRetried(message))) {
    return false;
  }
  return message.metadata?.synthetic !== true || isRetriedSyntheticMessage(message);
}

/**
 * The delegated workspace turn that a resume of this retry row continues. A compaction request
 * resumes into its follow-up, which carries the turn in `workspaceTurnMetadata` when another
 * trigger (a wake) owns its `muxMetadata`.
 */
export function retriedWorkspaceTurn(
  row: MuxMessage | undefined
): WorkspaceTurnTaskCorrelation | null {
  const muxMetadata = row?.metadata?.muxMetadata;
  const followUp = getCompactionFollowUpContent(muxMetadata);
  return parseWorkspaceTurnTaskCorrelation(
    followUp == null ? muxMetadata : (followUp.workspaceTurnMetadata ?? followUp.muxMetadata)
  );
}
