import React from "react";
import type { DisplayedMessage } from "@/common/types/message";
import type { ReviewNoteData } from "@/common/types/review";
import type { BashOutputGroupInfo } from "@/browser/utils/messages/messageUtils";
import type { TaskReportLinking } from "@/browser/utils/messages/taskReportLinking";
import { useToolCards } from "../Tools/Shared/toolCardsStore";
import { ToolCardFallback } from "../Tools/Shared/ToolCardsLoad";
import {
  HookOutputDisplay,
  extractHookOutput,
  extractHookDuration,
} from "../Tools/Shared/HookOutputDisplay";
import { ToolNameProvider } from "./ToolNameContext";

interface ToolMessageProps {
  message: DisplayedMessage & { type: "tool" };
  className?: string;
  workspaceId?: string;
  /** Handler for adding review notes from inline diffs */
  onReviewNote?: (data: ReviewNoteData) => void;
  /** Whether this is the latest propose_plan in the conversation */
  isLatestProposePlan?: boolean;
  /** Optional bash_output grouping info */
  bashOutputGroup?: BashOutputGroupInfo;
  /** Optional task report linking context (computed at render-time) */
  taskReportLinking?: TaskReportLinking;
  /**
   * False where another surface owns the row's hook output: the ask_user_question dock renders
   * the same row as the transcript, so its hook output stays with the transcript row.
   */
  showHookOutput?: boolean;
}

export const ToolMessage: React.FC<ToolMessageProps> = ({
  message,
  className,
  workspaceId,
  onReviewNote,
  isLatestProposePlan,
  bashOutputGroup,
  taskReportLinking,
  showHookOutput = true,
}) => {
  const { toolName, args, result, status, toolCallId } = message;

  // The cards load lazily (see toolCardsStore). The outer div stays across the swap.
  const cards = useToolCards();
  if (!cards) {
    return (
      <div className={className}>
        <ToolCardFallback toolName={toolName} status={status} />
      </div>
    );
  }
  // Get the component from the registry (validates args, falls back to GenericToolCall)
  const ToolComponent = cards.getToolComponent(toolName, args, result);

  // Compute tool-specific extras
  const groupPosition =
    bashOutputGroup?.position === "first" || bashOutputGroup?.position === "last"
      ? bashOutputGroup.position
      : undefined;

  // Extract hook output if present (only shown when hook produced output)
  const hookOutput = showHookOutput ? extractHookOutput(result) : undefined;
  const hookDuration = extractHookDuration(result);
  return (
    <div className={className}>
      {/* ToolNameProvider lets useStickyExpand key the auto-expand preference by tool name. */}
      <ToolNameProvider toolName={toolName}>
        <ToolComponent
          // Base props (all tools)
          args={args}
          result={result ?? null}
          status={status}
          toolName={toolName}
          // Identity props (used by bash for live output, ask_user_question for caching)
          workspaceId={workspaceId}
          toolCallId={toolCallId}
          // Tells apart rows that reuse a tool call id (ask_user_question answers and drafts)
          rowId={message.id}
          // Workflow-specific
          workflowRunHint={message.workflowRun}
          // Elapsed timers (bash/task_await): start when execute() actually
          // began running, not when the model emitted the call — parallel tool calls
          // run sequentially, so queued calls must not accumulate elapsed time.
          startedAt={message.executionStartedAt}
          // Freshness lower bound (task/workflow discovery): when the model emitted the
          // call. Unlike executionStartedAt this survives history replay of parts that
          // predate execution-start tracking.
          toolCallTimestamp={message.timestamp}
          // FileEdit-specific
          onReviewNote={onReviewNote}
          // ProposePlan-specific
          isLatest={isLatestProposePlan}
          // BashOutput-specific
          groupPosition={groupPosition}
          // Task-specific
          taskReportLinking={taskReportLinking}
          // CodeExecution-specific
          nestedCalls={message.nestedCalls}
          // MCP tools (GenericToolCall): frozen per-call server identity
          mcpServer={message.mcpServer}
        />
      </ToolNameProvider>
      {hookOutput && <HookOutputDisplay output={hookOutput} durationMs={hookDuration} />}
    </div>
  );
};
