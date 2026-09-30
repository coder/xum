import React from "react";
import type { DisplayedMessage } from "@/common/types/message";
import type { ReviewNoteData } from "@/common/types/review";
import type { BashOutputGroupInfo } from "@/browser/utils/messages/messageUtils";
import type { TaskReportLinking } from "@/browser/utils/messages/taskReportLinking";
import { getToolComponent } from "../Tools/Shared/getToolComponent";
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
}

export const ToolMessage: React.FC<ToolMessageProps> = ({
  message,
  className,
  workspaceId,
  onReviewNote,
  isLatestProposePlan,
  bashOutputGroup,
  taskReportLinking,
}) => {
  const { toolName, args, result, status, toolCallId } = message;

  // Get the component from the registry (validates args, falls back to GenericToolCall)
  const ToolComponent = getToolComponent(toolName, args, result);

  // Compute tool-specific extras
  const groupPosition =
    bashOutputGroup?.position === "first" || bashOutputGroup?.position === "last"
      ? bashOutputGroup.position
      : undefined;

  // Extract hook output if present (only shown when hook produced output)
  const hookOutput = extractHookOutput(result);
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
          // Workflow-specific
          workflowRunHint={message.workflowRun}
          // Elapsed timers (bash/advisor/task_await): start when execute() actually
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
