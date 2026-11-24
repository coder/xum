import React from "react";
import { cn } from "@/common/lib/utils";
import type { DisplayedMessage } from "@/common/types/message";
import { showAllMessages } from "@/browser/stores/WorkspaceStore";

interface HistoryHiddenMessageProps {
  message: DisplayedMessage & { type: "history-hidden" };
  workspaceId?: string;
  className?: string;
  /** Overrides the WorkspaceStore "Load all" path for hosts with their own aggregator. */
  onShowAll?: () => void;
}

export const HistoryHiddenMessage: React.FC<HistoryHiddenMessageProps> = ({
  message,
  workspaceId,
  className,
  onShowAll,
}) => {
  const handleShowAll = onShowAll ?? (workspaceId ? () => showAllMessages(workspaceId) : undefined);
  const omittedMessageDetails: string[] = [];
  if (message.omittedMessageCounts?.tool) {
    omittedMessageDetails.push(
      `${message.omittedMessageCounts.tool} tool call${message.omittedMessageCounts.tool === 1 ? "" : "s"}`
    );
  }
  if (message.omittedMessageCounts?.reasoning) {
    omittedMessageDetails.push(
      `${message.omittedMessageCounts.reasoning} thinking block${message.omittedMessageCounts.reasoning === 1 ? "" : "s"}`
    );
  }

  const hiddenCountSummary = `${message.hiddenCount} message${message.hiddenCount === 1 ? "" : "s"} hidden`;
  const detailSummary =
    omittedMessageDetails.length > 0
      ? `${hiddenCountSummary} (${omittedMessageDetails.join(", ")})`
      : hiddenCountSummary;

  return (
    <div
      className={cn(
        "my-4 flex flex-wrap items-center justify-center gap-2 text-center text-xs text-muted",
        className
      )}
    >
      <svg
        aria-hidden="true"
        className="text-border shrink-0"
        width="24"
        height="8"
        viewBox="0 0 24 8"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          d="M0 4 Q4 0, 8 4 Q12 8, 16 4 Q20 0, 24 4"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          fill="none"
        />
      </svg>
      <span className="text-muted">Some messages are hidden for performance • {detailSummary}</span>
      {handleShowAll && (
        <button
          type="button"
          className="text-link hover:text-link-hover cursor-pointer border-none bg-transparent p-0 font-medium underline"
          onClick={() => handleShowAll()}
        >
          Load all
        </button>
      )}
      <svg
        aria-hidden="true"
        className="text-border shrink-0"
        width="24"
        height="8"
        viewBox="0 0 24 8"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          d="M0 4 Q4 0, 8 4 Q12 8, 16 4 Q20 0, 24 4"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          fill="none"
        />
      </svg>
    </div>
  );
};
