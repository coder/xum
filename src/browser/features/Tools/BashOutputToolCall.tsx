import React from "react";
import { Layers, Link } from "lucide-react";
import type { BashOutputToolArgs, BashOutputToolResult } from "@/common/types/tools";
import {
  ToolContainer,
  ToolHeader,
  ExpandIcon,
  StatusIndicator,
  ToolDetails,
  DetailSection,
  DetailLabel,
  DetailContent,
  LoadingDots,
  ToolIcon,
  ErrorBox,
  OutputStatusBadge,
  ProcessStatusBadge,
  OutputSection,
} from "./Shared/ToolPrimitives";
import { useToolExpansion, getStatusDisplay, type ToolStatus } from "./Shared/toolUtils";

interface BashOutputToolCallProps {
  args: BashOutputToolArgs;
  result?: BashOutputToolResult;
  status?: ToolStatus;
  /** Position in a group of consecutive bash_output calls (undefined if not grouped) */
  groupPosition?: "first" | "last";
}

/**
 * Display component for bash_output tool calls.
 * Shows output from background processes in a format matching regular bash tool.
 */
export const BashOutputToolCall: React.FC<BashOutputToolCallProps> = ({
  args,
  result,
  status = "pending",
  groupPosition,
}) => {
  const { expanded, toggleExpanded } = useToolExpansion();

  // Derive process status display
  const processStatus = result?.success ? result.status : undefined;
  const note = result?.success ? result.note : undefined;

  return (
    <ToolContainer expanded={expanded}>
      <ToolHeader onClick={toggleExpanded}>
        <ExpandIcon expanded={expanded} />
        <ToolIcon toolName="bash_output" />
        <span className="text-text font-monospace max-w-96 truncate">{args.process_id}</span>
        <span className="text-muted ml-2 flex items-center gap-1 text-[10px] whitespace-nowrap">
          <Layers size={10} />
          output
          {args.timeout_secs > 0 && ` • wait ${args.timeout_secs}s`}
          {args.filter && ` • ${args.filter_exclude ? "exclude" : "filter"}: ${args.filter}`}
          {groupPosition && (
            <span className="text-muted ml-1 flex items-center gap-0.5">
              • <Link size={8} /> {groupPosition === "first" ? "start" : "end"}
            </span>
          )}
        </span>
        {result?.success && <OutputStatusBadge hasOutput={!!result.output} className="ml-2" />}
        {result?.success && processStatus && processStatus !== "running" && (
          <ProcessStatusBadge status={processStatus} exitCode={result.exitCode} className="ml-2" />
        )}
        <StatusIndicator status={status}>{getStatusDisplay(status)}</StatusIndicator>
      </ToolHeader>

      {expanded && (
        <ToolDetails>
          {result && (
            <>
              {result.success === false && (
                <DetailSection>
                  <DetailLabel>Error</DetailLabel>
                  <ErrorBox>{result.error}</ErrorBox>
                </DetailSection>
              )}

              {result.success && (
                <OutputSection output={result.output} note={note} emptyMessage="No new output" />
              )}
            </>
          )}

          {status === "executing" && result === undefined && (
            <DetailSection>
              <DetailContent className="px-2 py-1.5">
                Waiting for result
                <LoadingDots />
              </DetailContent>
            </DetailSection>
          )}
        </ToolDetails>
      )}
    </ToolContainer>
  );
};
