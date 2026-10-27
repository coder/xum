import React from "react";
import { CircleStopIcon, Square } from "lucide-react";

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
  /**
   * With chips in a phone-width row, let a dot stand in for the status label (default false).
   * Only for phases the rest of the row still names: Stop marks a running turn (starting,
   * streaming), and the awaiting-input hint asks for a reply. The other phases (compacting,
   * waiting on a bash monitor, whose hint hides on phones) keep their label.
   */
  compactStatusOnNarrow?: boolean;
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
        {props.statusText !== null && (
          <StatusLabel
            statusText={props.statusText}
            tps={props.tps}
            inLiveLine={props.activity !== undefined}
            compactOnNarrow={props.compactStatusOnNarrow === true}
          />
        )}
        {props.hintElement}
        {props.activity !== undefined && (
          <ActivityChips
            showDivider={props.statusText !== null}
            compactOnNarrow={props.compactStatusOnNarrow === true}
          >
            {props.activity}
          </ActivityChips>
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
              // The chips take the row's free width beside Stop (approved line design).
              "group-has-[[data-activity-chip]]/live:hidden",
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
        {props.statusText !== null && <LineEnd {...props} />}
      </div>
    </div>
  );
};

/**
 * Stop, or the phase's hint. The approved desktop line divides the chips from Stop; the phone
 * line does not.
 */
function LineEnd(props: StreamingBarrierViewProps) {
  return (
    <>
      {props.activity !== undefined && props.cancelText.length > 0 && (
        <span
          aria-hidden
          className="bg-border-light mr-3 hidden h-3 w-px shrink-0 @md:group-has-[[data-activity-chip]]/live:block"
        />
      )}
      <CancelControl {...props} />
    </>
  );
}

function StatusLabel(props: {
  statusText: string;
  tps?: number;
  inLiveLine: boolean;
  compactOnNarrow: boolean;
}) {
  return (
    <>
      {/* The composer's live line leads with a status dot. With chips in a phone-width row it
          stands in for the label (still read out by screen readers) so the chips keep the room. */}
      {props.inLiveLine && (
        <span
          aria-hidden
          className="bg-assistant-border ring-assistant-border/30 size-2 shrink-0 animate-pulse rounded-full ring-[3px]"
        />
      )}
      <span
        className={cn(
          "text-assistant-border min-w-0 animate-pulse truncate font-mono text-[10px] tracking-wide uppercase @md:group-has-[[data-activity-chip]]/live:shrink-0",
          props.compactOnNarrow
            ? "@max-md:group-has-[[data-activity-chip]]/live:sr-only"
            : // A phase without Stop keeps its label on phones; it truncates before the chips do.
              "@max-md:group-has-[[data-activity-chip]]/live:max-w-[45%]"
        )}
      >
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

function ActivityChips(props: {
  showDivider: boolean;
  compactOnNarrow: boolean;
  children: React.ReactNode;
}) {
  return (
    <>
      {/* Where the status label collapses to its dot (phones), the dot needs no divider. */}
      {props.showDivider && (
        <span
          aria-hidden
          className={cn(
            "bg-border-light hidden h-3 w-px shrink-0",
            props.compactOnNarrow
              ? "@md:group-has-[[data-activity-chip]]/live:block"
              : "group-has-[[data-activity-chip]]/live:block"
          )}
        />
      )}
      {/* Chips scroll sideways rather than wrap when a phone-width row runs out of room.
          No edge-fade mask here: a mask would also clip the chips' panels, which render
          inside this row but are positioned against the whole line. With chips the strip takes
          the row's free width, and the spacer (between the plain TODO chip and the bordered
          chips, by flex order) ends the line with the bordered chips next to Stop. */}
      <div className="flex min-w-0 scrollbar-none items-center gap-1.5 overflow-x-auto has-[[data-activity-chip]]:flex-1">
        {props.children}
        <span aria-hidden className="order-1 min-w-0 flex-1" />
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
        className={cn(
          "text-muted hover:text-foreground inline-flex h-6 cursor-pointer items-center rounded-sm px-1.5 py-0.5 text-[11px] leading-none font-medium transition-colors duration-200",
          // Beside chips in a phone-width row: a round icon button (approved phone design).
          "@max-md:group-has-[[data-activity-chip]]/live:border-border-medium @max-md:group-has-[[data-activity-chip]]/live:text-foreground @max-md:group-has-[[data-activity-chip]]/live:size-8 @max-md:group-has-[[data-activity-chip]]/live:justify-center @max-md:group-has-[[data-activity-chip]]/live:rounded-full @max-md:group-has-[[data-activity-chip]]/live:border @max-md:group-has-[[data-activity-chip]]/live:p-0"
        )}
        aria-label="Stop streaming"
      >
        <CircleStopIcon
          className="h-3.5 w-3.5 shrink-0 @max-md:group-has-[[data-activity-chip]]/live:hidden"
          strokeWidth={2.2}
        />
        <Square
          aria-hidden
          className="hidden size-3 shrink-0 fill-current @max-md:group-has-[[data-activity-chip]]/live:block"
        />
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
