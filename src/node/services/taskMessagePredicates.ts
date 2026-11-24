// Pure predicates over chat messages that TaskService uses to find supersession points and
// terminal workflow results. Moved out of taskService.ts unchanged; they hold no state.
import { CONTEXT_BOUNDARY_KINDS } from "@/common/constants/contextBoundary";
import type { MuxMessage } from "@/common/types/message";
import { isDynamicToolPart } from "@/common/types/toolParts";
import { isTerminalWorkflowRunToolOutput } from "@/common/utils/workflowRunMessages";

export function isInternalResumeAutoCompactionMessage(message: MuxMessage): boolean {
  const muxMetadata = message.metadata?.muxMetadata;
  if (muxMetadata?.type !== "compaction-request" || muxMetadata.source !== "auto-compaction") {
    return false;
  }
  return muxMetadata.parsed.followUpContent?.dispatchOptions?.source === "internal-resume";
}

export function isSyntheticManualSupersessionMessage(message: MuxMessage): boolean {
  const muxMetadata = message.metadata?.muxMetadata;
  return (
    message.metadata?.synthetic === true &&
    muxMetadata?.type === "compaction-request" &&
    muxMetadata.source === "auto-compaction" &&
    !isInternalResumeAutoCompactionMessage(message)
  );
}

export function isManualUserSupersessionMessage(message: MuxMessage): boolean {
  return (
    message.role === "user" &&
    (message.metadata?.synthetic !== true || isSyntheticManualSupersessionMessage(message))
  );
}

export function isResetBoundaryMessage(message: MuxMessage): boolean {
  return message.metadata?.contextBoundaryKind === CONTEXT_BOUNDARY_KINDS.RESET;
}

export function isCompactionRequestMessage(message: MuxMessage): boolean {
  return message.metadata?.muxMetadata?.type === "compaction-request";
}

export function isWorkflowSupersessionMessage(message: MuxMessage): boolean {
  return isManualUserSupersessionMessage(message) || isResetBoundaryMessage(message);
}

export function isFailedWorkflowRunSnapshot(value: unknown, runId: string): boolean {
  if (value == null || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return record.id === runId && record.status === "failed";
}

export function isTerminalWorkflowTaskAwaitRecord(
  record: Record<string, unknown>,
  runId: string
): boolean {
  if (record.taskId !== runId) {
    return false;
  }
  if (record.status === "completed" || record.status === "interrupted") {
    return true;
  }
  if (record.status === "error") {
    return isFailedWorkflowRunSnapshot(record.run, runId);
  }
  return false;
}

export function hasTerminalWorkflowTaskAwaitInParts(
  parts: readonly unknown[],
  runId: string
): boolean {
  return parts.some((part) => {
    if (!isDynamicToolPart(part) || part.toolName !== "task_await") {
      return false;
    }
    if (part.state !== "output-available") {
      return false;
    }
    const output = part.output;
    if (output == null || typeof output !== "object") {
      return false;
    }
    const results = (output as Record<string, unknown>).results;
    if (!Array.isArray(results)) {
      return false;
    }
    return results.some((result) => {
      if (result == null || typeof result !== "object") {
        return false;
      }
      return isTerminalWorkflowTaskAwaitRecord(result as Record<string, unknown>, runId);
    });
  });
}

export function hasTerminalWorkflowToolOutputInParts(
  parts: readonly unknown[],
  runId: string
): boolean {
  return parts.some(
    (part) =>
      isDynamicToolPart(part) &&
      part.state === "output-available" &&
      isTerminalWorkflowRunToolOutput(part.toolName, part.output, runId)
  );
}
