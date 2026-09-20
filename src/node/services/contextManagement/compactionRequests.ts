import type { ReviewNoteDataForDisplay } from "@/common/types/message";
import assert from "@/common/utils/assert";
import { selectKeepRecentTailStartIndex } from "@/common/utils/messages/keepRecentTail";
import { isNonNegativeInteger } from "@/common/utils/numbers";
import { RLM_KEEP_RECENT_FLOOR_TOKENS } from "@/constants/rlmCompaction";
import type { HistoryService } from "../historyService";
import type { SendMessageOptions, FilePart } from "@/common/orpc/types";
import {
  pickPreservedSendOptions,
  type CompactionFollowUpRequest,
  type MuxMessage,
  type MuxMessageMetadata,
} from "@/common/types/message";
import type { GoalSyntheticMessageKind } from "@/constants/goals";
import type { AutoModelRoutingRecord } from "@/common/types/autoModelRouting";

export function buildAutoCompactionFollowUp(params: {
  messageText: string;
  options: SendMessageOptions;
  modelForStream: string;
  fileParts?: FilePart[];
  agentInitiated?: boolean;
  goalKind?: GoalSyntheticMessageKind;
  goalId?: string;
  muxMetadata?: MuxMessageMetadata;
  workspaceTurnMetadata?: Extract<MuxMessageMetadata, { type: "workspace-turn-task" }>;
  autoModelRouting?: AutoModelRoutingRecord;
}): CompactionFollowUpRequest {
  const followUp: CompactionFollowUpRequest = {
    text: params.messageText,
    model: params.modelForStream,
    agentId: params.options.agentId,
    ...pickPreservedSendOptions(params.options),
  };

  if (params.agentInitiated === true) {
    followUp.agentInitiated = true;
  }

  if (params.goalKind != null) {
    followUp.goalKind = params.goalKind;
  }

  if (params.goalId != null) {
    followUp.goalId = params.goalId;
  }

  if (params.fileParts && params.fileParts.length > 0) {
    followUp.fileParts = params.fileParts;
  }

  if (params.muxMetadata) {
    followUp.muxMetadata = params.muxMetadata;
  }

  if (params.workspaceTurnMetadata) {
    followUp.workspaceTurnMetadata = params.workspaceTurnMetadata;
  }

  if (params.autoModelRouting) {
    followUp.autoModelRouting = params.autoModelRouting;
  }

  return followUp;
}

export function inheritOpenWorkspaceTurnMetadata(
  messages: readonly MuxMessage[]
): Extract<MuxMessageMetadata, { type: "workspace-turn-task" }> | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    const muxMetadata = message.metadata?.muxMetadata;
    if (message.role === "assistant") {
      if (
        muxMetadata?.type === "workspace-turn-task" &&
        message.metadata?.partial !== true &&
        message.metadata?.finishReason === "tool-calls"
      ) {
        return muxMetadata;
      }
      // On-send compaction can consume a monitor-wake continuation mid-turn,
      // hiding the correlated queue-cut assistant behind the new boundary. The
      // pre-compaction correlation is stamped on the summary's pending
      // follow-up (see the on-send divert in sendMessage), so the wake
      // continuation re-inherits it from there.
      if (
        muxMetadata?.type === "compaction-summary" &&
        muxMetadata.pendingFollowUp?.workspaceTurnMetadata != null
      ) {
        return muxMetadata.pendingFollowUp.workspaceTurnMetadata;
      }
      return undefined;
    }
    if (message.role === "user") {
      if (muxMetadata?.type === "bash-monitor-wake") {
        continue;
      }
      return undefined;
    }
  }
  return undefined;
}

export async function computeKeepRecentTailStamp(
  historyService: HistoryService,
  workspaceId: string,
  enabled: boolean
): Promise<{ startHistorySequence: number } | undefined> {
  if (!enabled) return undefined;
  const historyResult = await historyService.getHistoryFromLatestBoundary(workspaceId);
  if (!historyResult.success) {
    return undefined;
  }

  const messages = historyResult.data;
  const startIndex = selectKeepRecentTailStartIndex(messages, RLM_KEEP_RECENT_FLOOR_TOKENS);
  if (startIndex === -1) {
    return undefined;
  }

  const startHistorySequence = messages[startIndex].metadata?.historySequence;
  assert(
    isNonNegativeInteger(startHistorySequence),
    "keep-recent tail selector must only pick rows with a valid historySequence"
  );
  return { startHistorySequence };
}

// Type guard for compaction request metadata
// Supports both new `followUpContent` and legacy `continueMessage` for backwards compatibility
export interface CompactionRequestMetadata {
  type: "compaction-request";
  source?: "idle-compaction" | "auto-compaction";
  parsed: {
    followUpContent?: CompactionFollowUpRequest;
    // Legacy field - older persisted requests may use this instead of followUpContent
    continueMessage?: {
      text?: string;
      imageParts?: FilePart[];
      reviews?: ReviewNoteDataForDisplay[];
      muxMetadata?: MuxMessageMetadata;
      model?: string;
      agentId?: string;
      mode?: "exec" | "plan"; // Legacy: older versions stored mode instead of agentId
    };
  };
}

export function isCompactionRequestMetadata(meta: unknown): meta is CompactionRequestMetadata {
  if (typeof meta !== "object" || meta === null) return false;
  const obj = meta as Record<string, unknown>;
  if (obj.type !== "compaction-request") return false;
  if (typeof obj.parsed !== "object" || obj.parsed === null) return false;
  return true;
}
