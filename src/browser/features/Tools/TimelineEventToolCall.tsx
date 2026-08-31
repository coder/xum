import React from "react";
import { Flag, Forward, Inbox, OctagonAlert, Split, type LucideIcon } from "lucide-react";
import {
  formatTimelineTime,
  getTimelineDayLabel,
  getTimelinePresentation,
} from "@/browser/features/RightSidebar/Timeline/timelinePresentation";
import type { TimelineEventToolArgs, TimelineEventToolResult } from "@/common/types/tools";
import { TimelineEventToolResultSchema } from "@/common/utils/tools/toolDefinitions";
import {
  ErrorBox,
  ExpandIcon,
  StatusIndicator,
  ToolContainer,
  ToolDetails,
  ToolHeader,
  ToolIcon,
} from "./Shared/ToolPrimitives";
import {
  extractToolErrorMessage,
  getStatusDisplay,
  unwrapResult,
  useToolExpansion,
  type ToolStatus,
} from "./Shared/toolUtils";

/**
 * Transcript card for the `timeline_event` tool — the agent's one-sentence note on the
 * durable workspace timeline. Collapsed, the note itself is the summary, tagged with its
 * category. Expanded, it previews the row as it lands in the Timeline tab (ask-mode ink,
 * category badge) under the feed's day header.
 *
 * Mirrors the timeline backend (TimelineEventToolResultSchema / timelineService.ts): a
 * successful result carries `recorded`, which is false when the note was throttled
 * (duplicate description or too many agent events in a short window) and nothing was
 * added to the timeline — the card must not claim otherwise.
 */

type TimelineEventCategory = NonNullable<TimelineEventToolArgs["category"]>;
type TimelineEventSuccess = Extract<TimelineEventToolResult, { success: true }>;

// The feed itself renders every agent.event row with the kind icon (Sparkles) and a
// plain-text category badge; these per-category glyphs are the card header's own
// vocabulary for telling categories apart at a glance.
const CATEGORY_PRESENTATION: Record<TimelineEventCategory, { icon: LucideIcon; blurb: string }> = {
  picked_up: {
    icon: Inbox,
    blurb: "External input pulled into the work — a review comment, CI failure, or issue.",
  },
  milestone: {
    icon: Flag,
    blurb: "A notable step landed — implemented, committed, pushed, or opened as a PR.",
  },
  decision: { icon: Split, blurb: "The approach changed, including why." },
  blocker: { icon: OctagonAlert, blurb: "Progress is blocked, or a blocker was cleared." },
  handoff: { icon: Forward, blurb: "Work was handed off." },
};

const AGENT_EVENT_PRESENTATION = getTimelinePresentation("agent.event");

const FALLBACK_BLURB = "A general agent event on the workspace timeline.";

/** Badge text exactly as TimelineEventRow derives it: underscores → spaces, or "Agent". */
function categoryBadgeLabel(category: TimelineEventCategory | null | undefined): string {
  return category?.replace(/_/g, " ") ?? "Agent";
}

const CategoryChip: React.FC<{ category: TimelineEventCategory | null | undefined }> = (props) => {
  const Icon =
    props.category != null
      ? CATEGORY_PRESENTATION[props.category].icon
      : AGENT_EVENT_PRESENTATION.icon;
  return (
    <span className="border-ask-mode/30 text-ask-mode inline-flex shrink-0 items-center gap-1 rounded border px-1 py-0.5 text-[9px] leading-none font-medium uppercase">
      <Icon aria-hidden="true" className="h-2.5 w-2.5 shrink-0" />
      {categoryBadgeLabel(props.category)}
    </span>
  );
};

// Static replica of the Timeline tab's agent-authored TimelineEventRow (TimelinePanel.tsx):
// icon ring, two-line title, category badge, timestamp. Non-interactive because it previews
// the feed from inside the transcript rather than living in it.
const TimelineRowPreview: React.FC<{
  description: string;
  category: TimelineEventCategory | null | undefined;
  timestamp: number | undefined;
}> = (props) => {
  const Icon = AGENT_EVENT_PRESENTATION.icon;
  return (
    <div
      data-testid="timeline-row-preview"
      className="border-ask-mode/25 bg-ask-mode-alpha grid w-full min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2 rounded-md border px-2 py-2 text-left"
    >
      <span className="border-ask-mode/40 text-ask-mode bg-surface-secondary mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border">
        <Icon className="h-3.5 w-3.5" />
      </span>
      <span className="min-w-0">
        <span className="text-content-primary line-clamp-2 min-w-0 text-xs font-medium">
          {props.description}
        </span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1.5">
          <span className="border-ask-mode/30 text-ask-mode shrink-0 rounded border px-1 py-px text-[9px] font-medium uppercase">
            {categoryBadgeLabel(props.category)}
          </span>
        </span>
      </span>
      {props.timestamp != null && (
        <time
          dateTime={new Date(props.timestamp).toISOString()}
          className="text-muted counter-nums shrink-0 pt-0.5 text-[10px]"
        >
          {formatTimelineTime(props.timestamp)}
        </time>
      )}
    </div>
  );
};

// Results flow verbatim from persisted transcripts, so validate against the schema rather
// than trusting the shape (self-healing: a malformed result degrades to a status note).
function extractTimelineEventSuccess(result: unknown): TimelineEventSuccess | null {
  const parsed = TimelineEventToolResultSchema.safeParse(result);
  return parsed.success && parsed.data.success ? parsed.data : null;
}

// Fallback body when no result state applies (mid-flight, interrupted, or a corrupt
// result). The header already shows the full args — description and category — so a
// one-line status note is all that is left to say.
const STATUS_NOTES: Record<ToolStatus, string> = {
  pending: "Waiting to record…",
  executing: "Recording to the workspace timeline…",
  backgrounded: "Recording to the workspace timeline…",
  completed: "Recorded status unavailable.",
  failed: "The note was not recorded.",
  interrupted: "Interrupted before the note was recorded.",
  redacted: "Result redacted.",
};

interface TimelineEventToolCallProps {
  args: TimelineEventToolArgs;
  result?: unknown;
  status?: ToolStatus;
  /** Initial expansion fallback (until the user toggles this tool in the workspace). */
  defaultExpanded?: boolean;
  /**
   * When the model emitted the call — approximates the recorded event's timestamp, which
   * the result does not carry. The preview omits its day header and time cell without it.
   */
  toolCallTimestamp?: number;
}

export const TimelineEventToolCall: React.FC<TimelineEventToolCallProps> = (props) => {
  const status = props.status ?? "pending";
  const { expanded, toggleExpanded } = useToolExpansion(props.defaultExpanded ?? false);

  // The backend trims before recording, so mirror it: a whitespace-only description (which
  // passes the schema's min length) renders the explicit empty placeholder, not blank text.
  const description = props.args.description.trim();
  const category = props.args.category;
  // Results can arrive wrapped in the SDK JSON container { type: "json", value: ... }.
  const result = unwrapResult(props.result);
  const errorMessage = extractToolErrorMessage(result);
  const success = extractTimelineEventSuccess(result);
  const blurb = category != null ? CATEGORY_PRESENTATION[category].blurb : FALLBACK_BLURB;

  return (
    <ToolContainer expanded={expanded}>
      <ToolHeader onClick={toggleExpanded}>
        <ExpandIcon expanded={expanded}>▶</ExpandIcon>
        <ToolIcon toolName="timeline_event" />
        <span className="text-secondary font-medium whitespace-nowrap">Timeline</span>
        <CategoryChip category={category} />
        {description.length > 0 ? (
          <span className="text-foreground min-w-0 truncate">{description}</span>
        ) : (
          <span className="text-muted min-w-0 truncate italic">(empty description)</span>
        )}
        {success != null && !success.recorded && (
          <span className="bg-warning-overlay text-warning border-warning/40 inline-flex shrink-0 items-center rounded-full border px-1.5 py-0.5 text-[10px] leading-none font-medium tracking-wide uppercase">
            Not recorded
          </span>
        )}
        <StatusIndicator status={status}>{getStatusDisplay(status)}</StatusIndicator>
      </ToolHeader>

      {expanded && (
        <ToolDetails>
          {errorMessage != null ? (
            <ErrorBox>{errorMessage}</ErrorBox>
          ) : success?.recorded ? (
            <div className="space-y-2">
              <div className="bg-code-bg rounded px-3 py-2.5">
                {props.toolCallTimestamp != null && (
                  <div className="text-muted mb-2 text-[10px] font-semibold tracking-wide uppercase">
                    {getTimelineDayLabel(props.toolCallTimestamp)}
                  </div>
                )}
                <TimelineRowPreview
                  description={description}
                  category={category}
                  timestamp={props.toolCallTimestamp}
                />
              </div>
              <div className="text-muted text-[10.5px] leading-relaxed">
                {blurb} Recorded on the durable workspace timeline — find it in the Timeline tab
                under <span className="text-foreground">Agent</span>.
              </div>
            </div>
          ) : success != null ? (
            <div data-testid="timeline-not-recorded" className="text-warning px-3 py-2 text-[11px]">
              Not recorded — a duplicate or too many notes in a short window. The timeline throttles
              agent events to stay a birds-eye record of the work.
            </div>
          ) : (
            <div className="text-muted px-3 py-2 text-[11px] italic">{STATUS_NOTES[status]}</div>
          )}
        </ToolDetails>
      )}
    </ToolContainer>
  );
};
