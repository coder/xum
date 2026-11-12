import React from "react";
import { NestedToolRenderer } from "./NestedToolRenderer";
import { getNestedToolStatus } from "./toolUtils";
import type { NestedToolCall } from "./codeExecutionTypes";

interface NestedToolsContainerProps {
  calls: NestedToolCall[];
  /** When true, incomplete tools show as interrupted instead of executing */
  parentInterrupted?: boolean;
  workspaceId?: string;
  toolCallTimestamp?: number;
}

/**
 * Renders nested tool calls as a list.
 * The parent owns the rail and inset. Preserve that inset for every nested
 * tool: cancelling it with negative margins makes bordered cards touch the rail
 * and forces each new tool renderer to work around the nesting layout.
 */
export const NestedToolsContainer: React.FC<NestedToolsContainerProps> = ({
  calls,
  parentInterrupted,
  workspaceId,
  toolCallTimestamp,
}) => {
  if (calls.length === 0) return null;

  // Nested rows read as one list under the code execution rail: each card drops its own
  // transcript margin and the list owns an even gap, so long runs stay compact.
  return (
    <div data-testid="nested-tool-calls" className="flex min-w-0 flex-col gap-1 [&>*]:!my-0">
      {calls.map((call) => {
        const status = getNestedToolStatus(
          call.state,
          call.output,
          parentInterrupted ?? false,
          call.failed
        );
        return (
          <NestedToolRenderer
            key={call.toolCallId}
            toolName={call.toolName}
            input={call.input}
            output={call.state === "output-available" ? call.output : undefined}
            status={status}
            workspaceId={workspaceId}
            toolCallId={call.toolCallId}
            toolCallTimestamp={call.timestamp ?? toolCallTimestamp}
            workflowRunHint={call.workflowRun}
            mcpServer={call.mcpServer}
          />
        );
      })}
    </div>
  );
};
