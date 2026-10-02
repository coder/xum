import React from "react";
import {
  ToolContainer,
  ToolHeader,
  ExpandIcon,
  ToolIcon,
  TOOL_NAME_TO_ICON,
  ToolName,
  StatusIndicator,
  ToolDetails,
  DetailSection,
  DetailLabel,
  DetailContent,
  LoadingDots,
} from "./Shared/ToolPrimitives";
import { useToolExpansion, getStatusDisplay, type ToolStatus } from "./Shared/toolUtils";
import { JsonHighlight } from "./Shared/HighlightedCode";
import { redactToolResultAttachmentsForDisplay } from "./Shared/toolResultDisplay";
import { ToolResultImages, extractImagesFromToolResult } from "./Shared/ToolResultImages";
import { MCPServerIdentityBadge } from "@/browser/components/MCPServerIdentity/MCPServerIdentityBadge";
import { useMcpIcon } from "@/browser/hooks/useMcpIcon";
import type { MCPToolCallDisplay } from "@/common/types/mcp";
import { mcpToolDisplayName } from "@/common/utils/mcp/mcpToolDisplayName";
import { AppWindow } from "lucide-react";
import { useChatHostContext } from "@/browser/contexts/ChatHostContext";
import { useExperimentValue } from "@/browser/hooks/useExperiments";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { openMcpAppView } from "@/browser/features/RightSidebar/ArtifactsTab/mcpAppViewsStore";

interface GenericToolCallProps {
  toolName: string;
  args?: unknown;
  result?: unknown;
  status?: ToolStatus;
  /**
   * Host-authored MCP identity frozen on the tool part for this call. Rows
   * without a snapshot (non-MCP tools, older history) render exactly as before.
   */
  mcpServer?: MCPToolCallDisplay;
  workspaceId?: string;
  toolCallId?: string;
}

/**
 * MCP Apps (artifacts experiment): tools that declare a ui:// view get an action that opens it
 * in the Artifacts tab. Own component so plain rows keep their exact previous render tree.
 */
const OpenMcpAppViewButton: React.FC<{
  mcpServer: MCPToolCallDisplay & { app: { resourceUri: string } };
  workspaceId: string;
  toolCallId: string;
  toolName: string;
  args: unknown;
  status: ToolStatus;
}> = (props) => {
  const enabled = useExperimentValue(EXPERIMENT_IDS.ARTIFACTS);
  // Hosts without an Artifacts surface (VS Code) cannot show the view.
  const canOpen = useChatHostContext().uiSupport.artifactsPanel === "supported";
  // Offered once the call settled: the view's result (or tool-cancelled) is decided at open
  // time, so a still-running call would wrongly show "Result no longer available".
  const settled =
    props.status === "completed" || props.status === "failed" || props.status === "interrupted";
  if (!enabled || !canOpen || !settled) return null;
  return (
    <button
      type="button"
      onClick={(e) => {
        // The header toggles expansion; this action must not.
        e.stopPropagation();
        openMcpAppView(props.workspaceId, {
          toolCallId: props.toolCallId,
          serverName: props.mcpServer.connection.key,
          resourceUri: props.mcpServer.app.resourceUri,
          toolName: props.toolName,
          label: mcpToolDisplayName(props.toolName, props.mcpServer.connection),
          arguments: props.args ?? {},
          cancelled: props.status === "interrupted" || props.status === "failed",
        });
      }}
      className="text-muted hover:text-foreground ml-auto inline-flex shrink-0 items-center gap-1 text-[11px]"
    >
      <AppWindow className="h-3 w-3" />
      Open in Artifacts
    </button>
  );
};

/**
 * Own component so only branded rows subscribe to the API context and the
 * icon lookup; plain rows keep their exact previous render tree.
 */
const McpServerBadge: React.FC<{ mcpServer: MCPToolCallDisplay }> = (props) => (
  <MCPServerIdentityBadge
    compact
    connection={props.mcpServer.connection}
    identity={props.mcpServer.identity}
    icon={useMcpIcon(props.mcpServer.iconRef)}
  />
);

export const GenericToolCall: React.FC<GenericToolCallProps> = ({
  toolName,
  args,
  result,
  status = "pending",
  mcpServer,
  workspaceId,
  toolCallId,
}) => {
  const { expanded, toggleExpanded } = useToolExpansion();

  const hasDetails = args !== undefined || result !== undefined;
  const images = extractImagesFromToolResult(result);
  const hasImages = images.length > 0;

  // Auto-expand if there are images to show
  const shouldShowDetails = expanded || hasImages;

  return (
    <ToolContainer expanded={shouldShowDetails}>
      <ToolHeader onClick={() => hasDetails && toggleExpanded()}>
        {hasDetails && <ExpandIcon expanded={shouldShowDetails}>▶</ExpandIcon>}
        {mcpServer && <McpServerBadge mcpServer={mcpServer} />}
        {TOOL_NAME_TO_ICON[toolName] && <ToolIcon toolName={toolName} />}
        {/* Display only: a plugin's stable installation ID stays in the model-facing
            name (dispatch, history, sticky expansion) but not in the readable label. */}
        <ToolName>
          {mcpServer ? mcpToolDisplayName(toolName, mcpServer.connection) : toolName}
        </ToolName>
        <StatusIndicator status={status}>{getStatusDisplay(status)}</StatusIndicator>
        {mcpServer?.app && workspaceId && toolCallId && (
          <OpenMcpAppViewButton
            mcpServer={{ ...mcpServer, app: mcpServer.app }}
            workspaceId={workspaceId}
            toolCallId={toolCallId}
            toolName={toolName}
            args={args}
            status={status}
          />
        )}
      </ToolHeader>

      {/* Always show images if present */}
      {hasImages && <ToolResultImages result={result} />}

      {expanded && hasDetails && (
        <ToolDetails>
          {args !== undefined && (
            <DetailSection>
              <DetailLabel>Arguments</DetailLabel>
              <DetailContent>
                <JsonHighlight value={args} />
              </DetailContent>
            </DetailSection>
          )}

          {result !== undefined && (
            <DetailSection>
              <DetailLabel>Result</DetailLabel>
              <DetailContent>
                <JsonHighlight value={redactToolResultAttachmentsForDisplay(result)} />
              </DetailContent>
            </DetailSection>
          )}

          {status === "executing" && result === undefined && (
            <DetailSection>
              <DetailContent>
                Waiting for result
                <LoadingDots />
              </DetailContent>
            </DetailSection>
          )}
          {status === "redacted" && (
            <DetailSection>
              <DetailContent className="text-muted italic">
                Output excluded from shared transcript
              </DetailContent>
            </DetailSection>
          )}
        </ToolDetails>
      )}
    </ToolContainer>
  );
};
