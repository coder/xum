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
import { AppWindow, Braces } from "lucide-react";
import { useChatHostContext } from "@/browser/contexts/ChatHostContext";
import { useExperimentValue } from "@/browser/hooks/useExperiments";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import {
  mcpAppViewRefFor,
  openMcpAppView,
  type McpAppViewRef,
} from "@/browser/features/RightSidebar/ArtifactsTab/mcpAppViewsStore";
import { McpAppFrame } from "@/browser/features/RightSidebar/ArtifactsTab/McpAppFrame";

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
 * MCP Apps (artifacts experiment): whether this host can show the view of a call. Hosts
 * without an Artifacts surface (VS Code) cannot.
 */
function useMcpAppViewsSupported(): boolean {
  const enabled = useExperimentValue(EXPERIMENT_IDS.ARTIFACTS);
  const canOpen = useChatHostContext().uiSupport.artifactsPanel === "supported";
  return enabled && canOpen;
}

/**
 * Tools that declare a ui:// view get an action that opens it in the Artifacts tab. Own
 * component so plain rows keep their exact previous render tree.
 */
const OpenMcpAppViewButton: React.FC<{ workspaceId: string; view: McpAppViewRef }> = (props) => {
  if (!useMcpAppViewsSupported()) return null;
  return (
    <button
      type="button"
      onClick={(e) => {
        // The header toggles expansion; this action must not.
        e.stopPropagation();
        openMcpAppView(props.workspaceId, props.view);
      }}
      className="text-muted hover:text-foreground ml-auto inline-flex shrink-0 items-center gap-1 text-[11px]"
    >
      <AppWindow className="h-3 w-3" />
      Open in Artifacts
    </button>
  );
};

/**
 * Expanded body of a call with an app view: the view itself (the spec's inline display mode),
 * with the raw input/output behind a toggle. The raw JSON renders below the view instead of
 * replacing it, so toggling never reloads the view or loses its state. Falls back to the raw
 * JSON where views are not supported.
 */
const McpAppToolDetails: React.FC<{
  workspaceId: string;
  view: McpAppViewRef;
  raw: React.ReactNode;
}> = (props) => {
  const [showRaw, setShowRaw] = React.useState(false);
  if (!useMcpAppViewsSupported()) return <ToolDetails>{props.raw}</ToolDetails>;
  return (
    <ToolDetails>
      <McpAppFrame workspaceId={props.workspaceId} view={props.view} variant="inline" />
      <button
        type="button"
        aria-expanded={showRaw}
        onClick={() => setShowRaw(!showRaw)}
        className="text-muted hover:text-foreground mt-1.5 inline-flex items-center gap-1 text-[11px]"
      >
        <Braces className="h-3 w-3" />
        {showRaw ? "Hide input/output" : "Show input/output"}
      </button>
      {showRaw && props.raw}
    </ToolDetails>
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

  // MCP Apps: the call's view, once it settled (null for plain rows).
  const appView =
    toolCallId != null ? mcpAppViewRefFor({ toolCallId, toolName, args, status, mcpServer }) : null;

  const rawDetails = (
    <>
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
    </>
  );

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
        {appView && workspaceId && (
          <OpenMcpAppViewButton workspaceId={workspaceId} view={appView} />
        )}
      </ToolHeader>

      {/* Always show images if present */}
      {hasImages && <ToolResultImages result={result} />}

      {expanded &&
        hasDetails &&
        (appView && workspaceId ? (
          <McpAppToolDetails workspaceId={workspaceId} view={appView} raw={rawDetails} />
        ) : (
          <ToolDetails>{rawDetails}</ToolDetails>
        ))}
    </ToolContainer>
  );
};
