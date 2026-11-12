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

/** "Worked" or "Thought", in the present while the stretch is live. */
function workVerb(item: WorkBundleInfo): string {
  const isLive = item.state === "live";
  if (item.kind === "thought") {
    return isLive ? "Thinking" : "Thought";
  }
  return isLive ? "Working" : "Worked";
}

function formatWorkLine(item: WorkBundleInfo, liveDurationMs: number | undefined): string {
  const isLive = item.state === "live";
  const verb = workVerb(item);
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
 * The one line a turn's work folds into at compact density: "Worked for 2m 14s · edited 2 files".
 * The label starts where the reply's text starts and the chevron follows it, the way Codex writes
 * a finished turn. A leading chevron indented every label past the reply and put a column of
 * chevrons down the page.
 */
export function WorkBundleMessage(props: WorkBundleMessageProps): React.ReactElement {
  const isLive = props.item.state === "live";
  const nowMs = useActiveNowMs(isLive && props.item.startedAtMs !== undefined);
  const liveDurationMs =
    isLive && props.item.startedAtMs !== undefined
      ? Math.max(0, nowMs - props.item.startedAtMs)
      : undefined;

  return (
    // The line belongs to what follows it: it sits close to the reply below and further from the
    // prompt above. A message block has a wide top margin of its own, so the one right after the
    // line gets a narrow one.
    <div className="mt-5 mb-0.5 px-1 [&+*>[data-message-block]]:mt-0.5">
      <button
        type="button"
        data-testid="work-bundle"
        className={cn(
          "text-muted hover:text-foreground inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-sm text-left transition-colors select-none",
          FOLDED_ROW_TEXT_CLASS,
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        )}
        aria-expanded={props.expanded}
        onClick={props.onToggle}
      >
        <span className="counter-nums min-w-0 truncate">
          {formatWorkLine(props.item, liveDurationMs)}
        </span>
        <ExpandIcon expanded={props.expanded} />
        {/* The running clock already says the turn is live; dots stand in only without one. */}
        {isLive && liveDurationMs === undefined && <LoadingDots aria-hidden="true" />}
      </button>
    </div>
  );
}
