import React from "react";
import type {
  BashBackgroundListArgs,
  BashBackgroundListResult,
  BashBackgroundListProcess,
} from "@/common/types/tools";
import {
  ToolContainer,
  ToolHeader,
  ExpandIcon,
  StatusIndicator,
  ToolDetails,
  DetailSection,
  LoadingDots,
  ToolIcon,
  ErrorBox,
} from "./Shared/ToolPrimitives";
import { useToolExpansion, getStatusDisplay, type ToolStatus } from "./Shared/toolUtils";
import { formatDuration } from "@/common/utils/formatDuration";
import { cn } from "@/common/lib/utils";

interface BashBackgroundListToolCallProps {
  args: BashBackgroundListArgs;
  result?: BashBackgroundListResult;
  status?: ToolStatus;
}

function getProcessStatusStyle(status: BashBackgroundListProcess["status"]) {
  switch (status) {
    case "running":
      return "bg-success text-on-success";
    case "exited":
      return "bg-[hsl(0,0%,40%)] text-white";
    case "killed":
    case "failed":
      return "bg-danger text-on-danger";
  }
}

export const BashBackgroundListToolCall: React.FC<BashBackgroundListToolCallProps> = ({
  args: _args,
  result,
  status = "pending",
}) => {
  const { expanded, toggleExpanded } = useToolExpansion(false);

  const processes = result?.success ? result.processes : [];
  const runningCount = processes.filter((p) => p.status === "running").length;

  return (
    <ToolContainer expanded={expanded}>
      <ToolHeader onClick={toggleExpanded}>
        <ExpandIcon expanded={expanded} />
        <ToolIcon toolName="bash_background_list" />
        <span className="text-text-secondary">
          {result?.success
            ? runningCount === 0
              ? "No background processes"
              : `${runningCount} background process${runningCount !== 1 ? "es" : ""}`
            : "Listing background processes"}
        </span>
        <StatusIndicator status={status}>{getStatusDisplay(status)}</StatusIndicator>
      </ToolHeader>

      {expanded && (
        <ToolDetails>
          {result?.success === false && (
            <DetailSection>
              <ErrorBox>{result.error}</ErrorBox>
            </DetailSection>
          )}

          {result?.success && processes.length > 0 && (
            <DetailSection>
              <div className="space-y-2">
                {processes.map((proc) => (
                  <div key={proc.process_id} className="bg-code-bg rounded px-2 py-1.5 text-[11px]">
                    <div className="mb-1 flex items-center gap-2">
                      <span className="text-text font-mono">
                        {proc.display_name ?? proc.process_id}
                      </span>
                      <span
                        className={cn(
                          "inline-block rounded px-1.5 py-0.5 text-[9px] font-medium uppercase",
                          getProcessStatusStyle(proc.status)
                        )}
                      >
                        {proc.status}
                        {proc.exitCode !== undefined && ` (${proc.exitCode})`}
                      </span>
                      <span className="text-text-secondary ml-auto">
                        {formatDuration(proc.uptime_ms)}
                      </span>
                    </div>
                    <div className="text-text-secondary truncate font-mono" title={proc.script}>
                      {proc.script}
                    </div>
                  </div>
                ))}
              </div>
            </DetailSection>
          )}

          {status === "executing" && !result && (
            <DetailSection>
              <div className="text-[11px]">
                Listing processes
                <LoadingDots />
              </div>
            </DetailSection>
          )}
        </ToolDetails>
      )}
    </ToolContainer>
  );
};
