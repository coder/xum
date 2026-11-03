// Which user row an automatic retry resumes. AgentSession's auto-retry and startup recovery
// replay this row, and WorkspaceTurnManager reads the same row to tell whether a turn can still
// be resumed, so both sides must select it here.
import {
  isContextBudgetWarningMessage,
  isSyntheticSnapshotUserMessage,
  type MuxMessage,
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

export function shouldUseUserMessageForRetry(message: MuxMessage): boolean {
  if (message.role !== "user" || message.metadata?.contextBudgetRejected) {
    return false;
  }

  if (isVisibleCompletedSubagentReportMessage(message)) {
    return false;
  }
  if (isSyntheticGoalPauseBoundaryMessage(message)) {
    return false;
  }
  if (isSyntheticSnapshotUserMessage(message)) {
    return false;
  }
  if (isContextBudgetWarningMessage(message)) {
    return false;
  }

  // Include UI-visible synthetic rows (e.g., crash-recovered compaction follow-ups)
  // so retries continue the most recent pending user intent.
  if (message.metadata?.synthetic === true) {
    return (
      message.metadata?.uiVisible === true ||
      message.metadata.muxMetadata?.contextBudgetContinuation === true ||
      isCompactionRequestMetadata(message.metadata?.muxMetadata)
    );
  }

  return true;
}
