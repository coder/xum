import React from "react";
import type { ToolStatus } from "./toolUtils";
import { getToolComponent } from "./getToolComponent";
import { HookOutputDisplay, extractHookDuration, extractHookOutput } from "./HookOutputDisplay";
import { ToolNameProvider } from "../../Messages/ToolNameContext";
import type { WorkflowRunToolAttachment } from "@/common/orpc/schemas/message";
import type { MCPToolCallDisplay } from "@/common/types/mcp";

interface NestedToolRendererProps {
  toolName: string;
  input: unknown;
  output?: unknown;
  status: ToolStatus;
  workspaceId?: string;
  toolCallId?: string;
  toolCallTimestamp?: number;
  /** Persisted run identity for nested workflow tool calls; only the workflow card consumes it. */
  workflowRunHint?: WorkflowRunToolAttachment;
  /** Frozen MCP identity for this nested call; only GenericToolCall consumes it. */
  mcpServer?: MCPToolCallDisplay;
}

/**
 * Routes nested tool calls to their specialized components.
 * Uses the shared registry for component lookup.
 */
export const NestedToolRenderer: React.FC<NestedToolRendererProps> = ({
  toolName,
  input,
  output,
  status,
  workspaceId,
  toolCallId,
  toolCallTimestamp,
  workflowRunHint,
  mcpServer,
}) => {
  const ToolComponent = getToolComponent(toolName, input);
  const hookOutput = extractHookOutput(output);
  const hookDuration = extractHookDuration(output);

  return (
    <>
      {/* ToolNameProvider lets useStickyExpand key the auto-expand preference by tool name. */}
      <ToolNameProvider toolName={toolName}>
        <ToolComponent
          args={input}
          result={output}
          status={status}
          toolName={toolName}
          workspaceId={workspaceId}
          toolCallId={toolCallId}
          toolCallTimestamp={toolCallTimestamp}
          workflowRunHint={workflowRunHint}
          mcpServer={mcpServer}
        />
      </ToolNameProvider>
      {hookOutput && <HookOutputDisplay output={hookOutput} durationMs={hookDuration} />}
    </>
  );
};
