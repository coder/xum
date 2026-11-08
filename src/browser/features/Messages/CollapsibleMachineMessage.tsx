import { useState, type ReactElement, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/common/lib/utils";
import { revealUnicodeTags } from "@/common/utils/agentPluginReviewText";
import { TranscriptQuoteRoot } from "./TranscriptQuoteBoundary";

interface CollapsibleMachineMessageProps {
  content: string;
  summary: string;
  icon: ReactNode;
  marker:
    | "background-work-wake"
    | "bash-monitor-wake"
    | "agent-peer-message-trigger"
    | "context-budget-warning"
    | "status-page-turn-end-nudge"
    | "todo-turn-end-nudge";
  className?: string;
}

/** Compact transcript treatment for machine-authored prompts whose raw control text is secondary. */
export function CollapsibleMachineMessage(props: CollapsibleMachineMessageProps): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const markerAttributes = { [`data-${props.marker}`]: true };

  return (
    <div
      {...markerAttributes}
      className={cn("my-2 flex min-w-0 flex-col items-end", props.className)}
      data-message-block
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((previous) => !previous)}
        className="text-muted hover:bg-muted/10 hover:text-foreground focus-visible:ring-ring focus-visible:ring-offset-background flex max-w-full cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-xs focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
      >
        {props.icon}
        {/* The summary interpolates a monitor's display name or another workspace's title, both of
            which a model or a peer can influence, so it reveals like the expanded body does. */}
        <span className="truncate">{revealUnicodeTags(props.summary)}</span>
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "size-3 shrink-0 transition-transform duration-200",
            expanded && "rotate-90"
          )}
        />
        <span className="sr-only">{expanded ? "Hide details" : "Show details"}</span>
      </button>
      {expanded && (
        // The quote attribute keeps `props.content` byte-for-byte: it is the text "Quote in input"
        // re-sends, and a revealed mark must never re-enter history. Only the drawn text is escaped.
        <TranscriptQuoteRoot text={props.content} className="mt-1.5 w-full">
          <pre className="text-muted bg-muted/5 border-border max-h-[40vh] overflow-y-auto rounded-md border p-2 text-xs leading-relaxed whitespace-pre-wrap">
            {revealUnicodeTags(props.content)}
          </pre>
        </TranscriptQuoteRoot>
      )}
    </div>
  );
}
