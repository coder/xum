import React from "react";
import { MessageSquareText } from "lucide-react";
import type { ReviewPaneUpdateToolArgs, ReviewPaneUpdateToolResult } from "@/common/types/tools";
import {
  ToolContainer,
  ToolHeader,
  ExpandIcon,
  StatusIndicator,
  ToolDetails,
  ToolIcon,
} from "./Shared/ToolPrimitives";
import { useToolExpansion, getStatusDisplay, type ToolStatus } from "./Shared/toolUtils";

interface ReviewPaneUpdateToolCallProps {
  args: ReviewPaneUpdateToolArgs;
  result?: ReviewPaneUpdateToolResult | { success: false; error: string };
  status?: ToolStatus;
}

/**
 * Custom renderer for `review_pane_update`. Shows the operation + hunk count
 * in the collapsed header; expanded view lists each pinned hunk with its
 * agent comment. We prefer the post-merge list from `result` when present so
 * users see what's actually pinned (after dedup); fall back to `args.hunks`
 * while the call is still pending or when the result is an error.
 */
export const ReviewPaneUpdateToolCall: React.FC<ReviewPaneUpdateToolCallProps> = ({
  args,
  result,
  status = "pending",
}) => {
  const { expanded, toggleExpanded } = useToolExpansion(false);
  const statusDisplay = getStatusDisplay(status);

  const successResult =
    result && "success" in result && result.success === true ? result : undefined;
  const errorMessage =
    status === "failed" && result && "success" in result && result.success === false
      ? result.error
      : undefined;

  // Show post-merge state when available so the user sees what's pinned after
  // dedup. Otherwise (pending / failed) show what the agent asked for.
  const displayHunks =
    successResult?.hunks ?? args.hunks.map((h) => ({ path: h.path, comment: h.comment ?? null }));

  const opLabel = args.operation === "replace" ? "Replace" : "Add";
  const verb = displayHunks.length === 0 ? "Cleared" : opLabel;
  const summary =
    displayHunks.length === 0
      ? "Cleared review focus"
      : `${verb} · ${displayHunks.length} hunk${displayHunks.length === 1 ? "" : "s"} pinned`;
  const rejectedCount = successResult?.rejected.length ?? 0;

  return (
    <ToolContainer expanded={expanded}>
      <ToolHeader onClick={toggleExpanded}>
        <ExpandIcon expanded={expanded}>▶</ExpandIcon>
        <ToolIcon toolName="review_pane_update" />
        <span className="text-muted-foreground flex min-w-0 flex-1 items-center gap-1 italic">
          <span className="truncate">{summary}</span>
          {rejectedCount > 0 && (
            <span className="text-warning-light-text shrink-0">· {rejectedCount} rejected</span>
          )}
        </span>
        {errorMessage && <span className="text-error-foreground">({errorMessage})</span>}
        <StatusIndicator status={status}>{statusDisplay}</StatusIndicator>
      </ToolHeader>

      {expanded && (
        <ToolDetails>
          {displayHunks.length === 0 ? (
            <div className="text-muted px-2 py-1.5 text-[11px] italic">No hunks pinned.</div>
          ) : (
            <ul className="flex flex-col gap-1.5 px-2 py-1.5">
              {displayHunks.map((hunk, i) => (
                <li
                  key={`${hunk.path}-${i}`}
                  className="border-border-light flex items-start gap-2 border-l-2 pl-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="font-monospace text-foreground text-[11px] break-all">
                      {hunk.path}
                    </div>
                    {hunk.comment && (
                      <div className="text-muted mt-0.5 flex items-start gap-1 text-[11px] leading-[1.4]">
                        <MessageSquareText
                          aria-hidden="true"
                          className="text-review-accent mt-[2px] h-3 w-3 shrink-0"
                        />
                        <span className="break-words whitespace-pre-wrap">{hunk.comment}</span>
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {successResult && successResult.rejected.length > 0 && (
            <div className="border-border-light mt-1 border-t px-2 py-1.5">
              <div className="text-muted text-[10px] tracking-wide uppercase">Rejected</div>
              <ul className="font-monospace text-warning-light-text mt-1 flex flex-col gap-0.5 text-[11px]">
                {successResult.rejected.map((entry, i) => (
                  <li key={`${entry}-${i}`} className="break-all">
                    {entry}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </ToolDetails>
      )}
    </ToolContainer>
  );
};
