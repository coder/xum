import React from "react";
import { CircleStopIcon } from "lucide-react";

import { cn } from "@/common/lib/utils";
import { TooltipIfPresent } from "@/browser/components/Tooltip/Tooltip";

export interface StreamingBarrierViewProps {
  /** Null when no turn is live: the row then shows only `activity`, and hides without chips. */
  statusText: string | null;
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
  /**
   * Activity chips (TODO, sub-agents, bashes, ...) that share this row so the dock spends one
   * line on them instead of one row each. Each chip marks itself with `data-activity-chip`, and
   * the row reads that marker in CSS (`group-has-[[data-activity-chip]]/live`): the chip
   * components decide on their own whether to render, so the row cannot know in JS.
   */
  activity?: React.ReactNode;
}

function hasLiveTps(tps: number | undefined): tps is number {
  return tps !== undefined && tps > 0;
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
        "@container group/live grid min-h-10 grid-cols-[minmax(0,1fr)_auto] items-center gap-4",
        // Between turns the row exists only for its chips.
        props.statusText === null && "hidden has-[[data-activity-chip]]:grid",
        props.className
      )}
    >
      {/* A live status is left-anchored chrome, not a centered transcript divider.
          Let long labels truncate and secondary stats yield before Stop is squeezed. */}
      <div className="flex min-w-0 items-center gap-2">
        {props.statusText !== null && <StatusLabel statusText={props.statusText} tps={props.tps} />}
        {props.hintElement}
        {props.activity !== undefined && (
          <ActivityChips showDivider={props.statusText !== null}>{props.activity}</ActivityChips>
        )}
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
              // Chips need the room more than the stats until the row is wide.
              "group-has-[[data-activity-chip]]/live:hidden @3xl:group-has-[[data-activity-chip]]/live:inline-flex",
              props.tokenCount === undefined && "invisible"
            )}
          >
            <span>~{(props.tokenCount ?? 0).toLocaleString()} tokens</span>
            <span className="text-dim ml-1 inline-flex min-w-[7ch] items-baseline justify-end gap-1">
              <span>@</span>
              <span>{hasLiveTps(props.tps) ? props.tps : "--"}</span>
              <span>t/s</span>
            </span>
          </span>
        )}
      </div>
      <div className="flex items-center whitespace-nowrap">
        {props.statusText !== null && <CancelControl {...props} />}
      </div>
    </div>
  );
};

function StatusLabel(props: { statusText: string; tps?: number }) {
  return (
    <>
      {/* With chips in a phone-width row, a pulsing dot stands in for the label (still read
          out by screen readers) so the chips keep the room; wider rows keep the full label. */}
      <span
        aria-hidden
        className="bg-assistant-border hidden size-1.5 shrink-0 animate-pulse rounded-full @max-md:group-has-[[data-activity-chip]]/live:block"
      />
      <span className="text-assistant-border min-w-0 animate-pulse truncate font-mono text-[10px] tracking-wide uppercase group-has-[[data-activity-chip]]/live:shrink-0 @max-md:group-has-[[data-activity-chip]]/live:sr-only">
        {props.statusText}
        {/* Narrow panes hide the stats slot, so they read t/s here. It follows the live prop
            rather than statusText, whose within-phase debounce would freeze the number, and
            comes last in the one truncating line so a long model name stays visible. Chips
            take that room when present. */}
        {hasLiveTps(props.tps) && (
          <span className="group-has-[[data-activity-chip]]/live:hidden @lg:hidden">
            {` at ${props.tps} t/s`}
          </span>
        )}
      </span>
    </>
  );
}

function ActivityChips(props: { showDivider: boolean; children: React.ReactNode }) {
  return (
    <>
      {props.showDivider && (
        <span
          aria-hidden
          className="bg-border-light hidden h-3 w-px shrink-0 group-has-[[data-activity-chip]]/live:block"
        />
      )}
      {/* Chips scroll sideways rather than wrap when a phone-width row runs out of room.
          No edge-fade mask here: a mask would also clip the chips' panels, which render
          inside this row but are positioned against the whole line. */}
      <div className="flex min-w-0 scrollbar-none items-center gap-1.5 overflow-x-auto">
        {props.children}
      </div>
    </>
  );
}

function CancelControl(props: StreamingBarrierViewProps) {
  return props.onCancel && props.cancelText.length > 0 ? (
    <TooltipIfPresent tooltip={props.cancelShortcutText} side="top">
      <button
        type="button"
        onClick={props.onCancel}
        className="text-muted hover:text-foreground inline-flex h-6 cursor-pointer items-center rounded-sm px-1.5 py-0.5 text-[11px] leading-none font-medium transition-colors duration-200"
        aria-label="Stop streaming"
      >
        <CircleStopIcon className="h-3.5 w-3.5 shrink-0" strokeWidth={2.2} />
        {/* Icon-only beside chips in a phone-width row; the aria-label still names it. */}
        <span className="ml-1 leading-none @max-md:group-has-[[data-activity-chip]]/live:hidden">
          Stop
        </span>
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
  );
}
