import React from "react";
import { formatElapsed } from "@/common/utils/formatDuration";
import { cn } from "@/common/lib/utils";
import {
  ExpandIcon,
  FOLDED_ROW_TEXT_CLASS,
  LoadingDots,
} from "@/browser/features/Tools/Shared/ToolPrimitives";
import type { WorkBundleInfo } from "@/browser/utils/messages/transcriptRenderProjection";

function useActiveNowMs(isActive: boolean): number {
  const [nowMs, setNowMs] = React.useState(() => Date.now());

  React.useEffect(() => {
    if (!isActive) {
      return;
    }

    setNowMs(Date.now());
    const intervalId = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(intervalId);
  }, [isActive]);

  return nowMs;
}

function formatWorkLine(item: WorkBundleInfo, liveDurationMs: number | undefined): string {
  const isLive = item.state === "live";
  const verb =
    item.kind === "thought" ? (isLive ? "Thinking" : "Thought") : isLive ? "Working" : "Worked";
  const durationMs = isLive ? liveDurationMs : item.durationMs;
  // Under a second there is nothing worth reading: "Worked" alone says it.
  const worked =
    durationMs === undefined || (!isLive && durationMs < 1000)
      ? verb
      : `${verb} for ${formatElapsed(durationMs)}`;
  // How long says little about a turn; that it changed files is what the user must not miss.
  if (item.editedFileCount === 0) {
    return worked;
  }
  return `${worked} · edited ${item.editedFileCount} ${item.editedFileCount === 1 ? "file" : "files"}`;
}

interface WorkBundleMessageProps {
  item: WorkBundleInfo;
  expanded: boolean;
  onToggle: () => void;
}

/**
 * The one line a turn's work folds into at compact density: "Worked for 2m 14s · edited 2 files". It uses the
 * same chevron-first muted line as every other folded row (a run of reads, a thought), so the
 * transcript has one way to say "there is more here".
 */
export function WorkBundleMessage(props: WorkBundleMessageProps): React.ReactElement {
  const isLive = props.item.state === "live";
  const nowMs = useActiveNowMs(isLive && props.item.startedAtMs !== undefined);
  const liveDurationMs =
    isLive && props.item.startedAtMs !== undefined
      ? Math.max(0, nowMs - props.item.startedAtMs)
      : undefined;

  return (
    <div className="my-1.5 px-1">
      <button
        type="button"
        data-testid="work-bundle"
        className={cn(
          "text-muted hover:text-foreground inline-flex max-w-full cursor-pointer items-center gap-2 rounded-sm text-left transition-colors select-none",
          FOLDED_ROW_TEXT_CLASS,
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        )}
        aria-expanded={props.expanded}
        onClick={props.onToggle}
      >
        <ExpandIcon expanded={props.expanded} />
        <span className="counter-nums min-w-0 truncate">
          {formatWorkLine(props.item, liveDurationMs)}
        </span>
        {/* The running clock already says the turn is live; dots stand in only without one. */}
        {isLive && liveDurationMs === undefined && <LoadingDots aria-hidden="true" />}
      </button>
    </div>
  );
}
