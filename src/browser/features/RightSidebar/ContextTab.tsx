import React from "react";
import { useWorkspaceConsumers } from "@/browser/stores/WorkspaceStore";
import { ConsumerBreakdown } from "./ConsumerBreakdown";
import { FileBreakdown } from "./FileBreakdown";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/browser/components/Tooltip/Tooltip";
import { PostCompactionSection } from "./PostCompactionSection";
import { usePostCompactionState } from "@/browser/hooks/usePostCompactionState";
import { useOptionalWorkspaceContext } from "@/browser/contexts/WorkspaceContext";

interface ContextTabProps {
  workspaceId: string;
}

export const ContextTab: React.FC<ContextTabProps> = ({ workspaceId }) => {
  const consumers = useWorkspaceConsumers(workspaceId);

  const postCompactionState = usePostCompactionState(workspaceId);

  // Get runtimeConfig for SSH-aware editor opening
  const workspaceContext = useOptionalWorkspaceContext();
  const runtimeConfig = workspaceContext?.workspaceMetadata.get(workspaceId)?.runtimeConfig;

  const hasConsumerData = consumers.totalTokens > 0 || consumers.isCalculating;
  const hasArtifacts =
    postCompactionState.planPath !== null || postCompactionState.trackedFilePaths.length > 0;

  if (!hasConsumerData && !hasArtifacts) {
    return (
      <div className="text-light font-primary text-[13px] leading-relaxed">
        <div className="text-dim py-2 text-xs italic">No context details available</div>
      </div>
    );
  }

  return (
    <div className="text-light font-primary text-[13px] leading-relaxed">
      <PostCompactionSection
        workspaceId={workspaceId}
        planPath={postCompactionState.planPath}
        trackedFilePaths={postCompactionState.trackedFilePaths}
        excludedItems={postCompactionState.excludedItems}
        onToggleExclusion={postCompactionState.toggleExclusion}
        runtimeConfig={runtimeConfig}
      />

      {consumers.topFilePaths && consumers.topFilePaths.length > 0 && (
        <div className="mt-4 mb-4">
          <h3 className="text-subtle m-0 mb-2 flex items-center gap-1 text-xs font-semibold tracking-wide uppercase">
            File Breakdown
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="text-dim cursor-help text-[10px] font-normal">ⓘ</span>
              </TooltipTrigger>
              <TooltipContent align="start" className="max-w-72 whitespace-normal">
                Token usage from file_read and file_edit tools, aggregated by file path. Consider
                splitting large files to reduce context usage.
              </TooltipContent>
            </Tooltip>
          </h3>
          <FileBreakdown files={consumers.topFilePaths} totalTokens={consumers.totalTokens} />
        </div>
      )}

      {(consumers.consumers.length > 0 || consumers.isCalculating) && (
        <div className="mt-4 mb-4">
          <h3 className="text-subtle m-0 mb-2 text-xs font-semibold tracking-wide uppercase">
            Consumer Breakdown
          </h3>
          {consumers.isCalculating ? (
            <div className="text-secondary py-2 text-xs italic">Calculating...</div>
          ) : (
            <ConsumerBreakdown
              consumers={consumers.consumers}
              totalTokens={consumers.totalTokens}
            />
          )}
        </div>
      )}
    </div>
  );
};
