import React from "react";
import { formatDuration } from "@/common/utils/formatDuration";
import { cn } from "@/common/lib/utils";
import { ExpandIcon } from "@/browser/features/Tools/Shared/ToolPrimitives";
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

interface WorkBundleMessageProps {
  item: WorkBundleInfo;
  expanded: boolean;
  onToggle: () => void;
}

export function WorkBundleMessage(props: WorkBundleMessageProps): React.ReactElement {
  const isActive = props.item.state === "active";
  const nowMs = useActiveNowMs(isActive && props.item.startedAtMs !== undefined);
  const duration = isActive
    ? props.item.startedAtMs === undefined
      ? undefined
      : Math.max(0, nowMs - props.item.startedAtMs)
    : props.item.durationMs;
  const label = isActive
    ? duration === undefined
      ? "Working..."
      : `Working for ${formatDuration(duration, "precise")}...`
    : duration === undefined
      ? "Worked"
      : `Worked for ${formatDuration(duration, "precise")}`;

  return (
    <button
      type="button"
      data-testid="work-bundle"
      className={cn(
        "text-muted hover:text-foreground flex w-full cursor-pointer items-center gap-2 border-b border-border/60 py-3 text-left text-base transition-colors select-none",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      )}
      aria-expanded={props.expanded}
      onClick={props.onToggle}
    >
      <span className="counter-nums min-w-0 truncate">{label}</span>
      <ExpandIcon expanded={props.expanded} className="text-muted shrink-0">
        ▶
      </ExpandIcon>
    </button>
  );
}
