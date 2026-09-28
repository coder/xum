import React from "react";
import { CircleStopIcon } from "lucide-react";

import { cn } from "@/common/lib/utils";
import { TooltipIfPresent } from "@/browser/components/Tooltip/Tooltip";

export interface StreamingBarrierViewProps {
  statusText: string;
  tokenCount?: number;
  tps?: number;
  cancelText: string;
  /** Optional click handler that turns cancelText into a tappable control. */
  onCancel?: () => void;
  /** Optional keyboard hint shown inline on larger screens (e.g., "Esc"). */
  cancelShortcutText?: string;
  className?: string;
  /** Optional hint element shown after status (e.g., settings link) */
  hintElement?: React.ReactNode;
  /**
   * Reserve the token-stats slot (default true). Streaming-bound phases keep it
   * so the starting -> streaming transition doesn't reflow the row; idle phases
   * (e.g. waiting on a bash monitor) skip it to fit narrow panes.
   */
  reserveStatsSlot?: boolean;
  /**
   * Hide the plain-text cancel hint when the barrier's container is narrow.
   * Use for low-priority informational hints that would overflow phone-width
   * transcripts; keep instructional hints (e.g. awaiting-input) always visible.
   */
  hideHintOnNarrow?: boolean;
}

/**
 * Presentation-only StreamingBarrier.
 *
 * Keep this file free of WorkspaceStore imports so it can be reused by alternate
 * frontends (e.g. the VS Code webview) without pulling in the desktop state layer.
 */
export const StreamingBarrierView: React.FC<StreamingBarrierViewProps> = (props) => {
  return (
    // @container scopes the narrow-hint query to the barrier's own width, so it
    // tracks the chat pane (which can be narrow on wide desktops), not the viewport.
    <div
      className={cn(
        "@container grid min-h-10 grid-cols-[minmax(0,1fr)_auto] items-center gap-4",
        props.className
      )}
    >
      {/* A live status is left-anchored chrome, not a centered transcript divider.
          Let long labels truncate and secondary stats yield before Stop is squeezed. */}
      <div className="flex min-w-0 items-center gap-2">
        <span className="text-assistant-border min-w-0 animate-pulse truncate font-mono text-[10px] tracking-wide uppercase">
          {props.statusText}
        </span>
        {props.hintElement}
        {/* Render the stats slot for streaming-bound phases so the row geometry is
            identical across the starting -> streaming transition; only its visibility
            toggles. Previously this slot mounted exactly when streaming began,
            reflowing the row (layout flash). Reserving it (with placeholder values)
            keeps the layout stable. */}
        {props.reserveStatsSlot !== false && (
          <span
            data-testid="streaming-barrier-stats"
            aria-hidden={props.tokenCount === undefined}
            className={cn(
              "text-assistant-border counter-nums-mono hidden min-w-[14ch] shrink-0 @lg:inline-flex items-baseline justify-end text-[11px] whitespace-nowrap select-none",
              props.tokenCount === undefined && "invisible"
            )}
          >
            <span>~{(props.tokenCount ?? 0).toLocaleString()} tokens</span>
            <span className="text-dim ml-1 inline-flex min-w-[7ch] items-baseline justify-end gap-1">
              <span>@</span>
              <span>{props.tps !== undefined && props.tps > 0 ? props.tps : "--"}</span>
              <span>t/s</span>
            </span>
          </span>
        )}
      </div>
      <div className="flex items-center whitespace-nowrap">
        {props.onCancel && props.cancelText.length > 0 ? (
          <TooltipIfPresent tooltip={props.cancelShortcutText} side="top">
            <button
              type="button"
              onClick={props.onCancel}
              className="text-muted hover:text-foreground inline-flex h-6 cursor-pointer items-center rounded-sm px-1.5 py-0.5 text-[11px] leading-none font-medium transition-colors duration-200"
              aria-label="Stop streaming"
            >
              <CircleStopIcon className="h-3.5 w-3.5 shrink-0" strokeWidth={2.2} />
              <span className="ml-1 leading-none">Stop</span>
              {props.cancelShortcutText && (
                <span className="border-border-medium text-muted ml-2 hidden items-center rounded border px-1 py-[1px] text-[10px] leading-none @lg:inline-flex">
                  {props.cancelShortcutText}
                </span>
              )}
            </button>
          </TooltipIfPresent>
        ) : (
          <span
            className={cn(
              "text-muted text-[11px] whitespace-nowrap select-none",
              // Low-priority hints yield to the status label in narrow panes
              // instead of forcing horizontal overflow.
              props.hideHintOnNarrow && "hidden @md:inline"
            )}
          >
            {props.cancelText}
          </span>
        )}
      </div>
    </div>
  );
};
