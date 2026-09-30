import React from "react";
import { Activity } from "lucide-react";
import { cn } from "@/common/lib/utils";
import {
  ToolContainer,
  ToolHeader,
  ExpandIcon,
  StatusIndicator,
  ToolDetails,
  ToolIcon,
  ErrorBox,
} from "./Shared/ToolPrimitives";
import {
  useToolExpansion,
  getStatusDisplay,
  isToolErrorResult,
  type ToolStatus,
} from "./Shared/toolUtils";
import { HeartbeatToolResultSchema } from "@/common/utils/tools/toolDefinitions";
import type { HeartbeatToolArgs, HeartbeatToolResult } from "@/common/types/tools";
import {
  HEARTBEAT_DEFAULT_CONTEXT_MODE,
  formatHeartbeatInterval,
  formatHeartbeatIntervalShort,
  resolveHeartbeatSchedulePolicy,
  type HeartbeatContextMode,
} from "@/constants/heartbeat";

/**
 * Transcript card for the `heartbeat` tool — the agent's recurring, idle-gated
 * self check-in. Reads as a glanceable status pill (cadence + state) in the
 * header and expands to the full schedule and check-in prompt.
 *
 * Mirrors the heartbeat backend (HeartbeatToolResultSchema / src/constants/heartbeat.ts):
 * `action` is get | set | unset, and a successful result carries the resolved
 * `settings` (null when nothing is configured) plus a human `summary`.
 */

type HeartbeatSuccess = Extract<HeartbeatToolResult, { success: true }>;
type HeartbeatSettings = NonNullable<HeartbeatSuccess["settings"]>;

// Terse, card-friendly context-mode copy. The config modal
// (WorkspaceHeartbeatModal) uses more verbose, instruction-flavored labels;
// a transcript card wants short descriptive blurbs instead.
const CONTEXT_MODES: Record<HeartbeatContextMode, { label: string; blurb: string }> = {
  normal: { label: "Normal", blurb: "Continues with full context" },
  compact: { label: "Compact", blurb: "Compacts context before each check-in" },
  reset: { label: "Reset", blurb: "Starts each check-in from a fresh boundary" },
};

/**
 * Narrow an arbitrary tool result to a successful heartbeat payload. Results
 * flow verbatim from persisted transcripts, so we validate against the schema
 * rather than trusting the shape (self-healing: a malformed result simply
 * renders no settings instead of throwing).
 */
function extractHeartbeatSuccess(result: unknown): HeartbeatSuccess | null {
  const parsed = HeartbeatToolResultSchema.safeParse(result);
  return parsed.success && parsed.data.success ? parsed.data : null;
}

type BadgeTone = "enabled" | "disabled" | "cleared";

// Green (live) shares the GoalStatusBadge palette so "active/healthy" reads the
// same across tool cards; amber means "kept but won't progress" (paused);
// muted means "not scheduled" (cleared / not set).
const BADGE_CLASSES: Record<BadgeTone, string> = {
  enabled: "bg-success/10 text-success border-success/40",
  disabled: "bg-warning-overlay text-warning border-warning/40",
  cleared: "bg-white/5 text-secondary border-white/10",
};

const HeartbeatBadge: React.FC<{ tone: BadgeTone; label: string }> = (props) => (
  <span
    className={cn(
      "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-1.5 py-0.5",
      "text-[10px] font-medium leading-none tracking-wide uppercase",
      BADGE_CLASSES[props.tone]
    )}
  >
    {props.tone === "enabled" ? (
      // Pulsing dot signals a live, ticking schedule; CSS gates it on reduced-motion.
      <span className="heartbeat-dot bg-success inline-block h-1.5 w-1.5 rounded-full" />
    ) : (
      <Activity aria-hidden="true" className="h-2.5 w-2.5" />
    )}
    {props.label}
  </span>
);

// The signature visual: a slim ECG strip that scans while the heartbeat is live.
const PULSE_TRACE_POINTS =
  "0,14 40,14 50,14 54,5 58,23 62,14 96,14 160,14 166,14 170,5 174,23 178,14 212,14 240,14";

const PulseTrace: React.FC<{ live: boolean }> = (props) => (
  <svg
    viewBox="0 0 240 28"
    preserveAspectRatio="none"
    className="block h-[26px] w-full"
    aria-hidden="true"
  >
    <line
      x1="0"
      y1="14"
      x2="240"
      y2="14"
      stroke="currentColor"
      strokeWidth="1"
      className="text-secondary"
      opacity="0.18"
    />
    <polyline
      points={PULSE_TRACE_POINTS}
      fill="none"
      stroke={props.live ? "var(--color-success)" : "var(--color-warning)"}
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={props.live ? "heartbeat-trace" : undefined}
      opacity={props.live ? 1 : 0.55}
    />
  </svg>
);

const HeartbeatStat: React.FC<{ label: string; value: React.ReactNode }> = (props) => (
  <div className="flex flex-col gap-0.5">
    <dt className="text-secondary text-[10px] tracking-wide uppercase">{props.label}</dt>
    <dd className="text-foreground leading-tight">{props.value}</dd>
  </div>
);

const REQUEST_ACTION_LABELS: Record<HeartbeatToolArgs["action"], string> = {
  set: "Schedule",
  get: "Read",
  unset: "Clear",
};

// Fallback for states with no resolved settings, error, or recognized empty result:
// in-flight/interrupted/redacted calls, or a degraded success (e.g. a corrupted set
// result with settings:null). Surfaces what the agent requested so the expanded card is
// never blank — the generic renderer used to show the raw args here.
const RequestedArgs: React.FC<{ args: HeartbeatToolArgs }> = (props) => {
  const args = props.args;
  const requestedMessage = args.message ?? "";
  return (
    <div className="bg-code-bg space-y-3 rounded px-3 py-2.5 text-[11px] leading-relaxed">
      <div className="text-secondary text-[10px] tracking-wide uppercase">Requested</div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3">
        <HeartbeatStat label="Action" value={REQUEST_ACTION_LABELS[args.action]} />
        {args.enabled != null && (
          <HeartbeatStat label="State" value={args.enabled ? "Enable" : "Pause"} />
        )}
        {args.intervalMs != null && (
          <HeartbeatStat
            label="Cadence"
            value={
              <span className="counter-nums">every {formatHeartbeatInterval(args.intervalMs)}</span>
            }
          />
        )}
        {args.contextMode != null && (
          <HeartbeatStat
            label="Context"
            value={CONTEXT_MODES[args.contextMode]?.label ?? args.contextMode}
          />
        )}
      </dl>
      {requestedMessage.length > 0 && (
        <div>
          <div className="text-secondary mb-1 text-[10px] tracking-wide uppercase">
            Check-in prompt
          </div>
          <div className="text-foreground border-l-2 border-white/10 pl-2.5 break-words whitespace-pre-wrap italic">
            {requestedMessage}
          </div>
        </div>
      )}
    </div>
  );
};

interface HeartbeatToolCallProps {
  args: HeartbeatToolArgs;
  result?: unknown;
  status?: ToolStatus;
  /** Initial expansion fallback (until the user toggles this tool in the workspace). */
  defaultExpanded?: boolean;
}

export const HeartbeatToolCall: React.FC<HeartbeatToolCallProps> = (props) => {
  const status = props.status ?? "pending";
  const { expanded, toggleExpanded } = useToolExpansion(props.defaultExpanded ?? false);

  const action = props.args.action;
  const errorResult = isToolErrorResult(props.result) ? props.result : null;
  const success = extractHeartbeatSuccess(props.result);
  const settings: HeartbeatSettings | null = success?.settings ?? null;
  const summary = success?.summary ?? null;

  const verb =
    action === "get"
      ? "Read heartbeat"
      : action === "unset"
        ? "Clear heartbeat"
        : "Schedule heartbeat";

  const live = settings?.enabled ?? false;
  const ctx = CONTEXT_MODES[settings?.contextMode ?? HEARTBEAT_DEFAULT_CONTEXT_MODE];
  // Effective schedule via the shared read-time resolver (unset fields resolve to defaults).
  const schedulePolicy = resolveHeartbeatSchedulePolicy(settings);
  // Only a custom `message` is stored per workspace; an empty string means it was
  // explicitly cleared. When there's no custom text the effective prompt is the
  // app-level default (`config.heartbeatDefaultPrompt`) or the built-in body — neither
  // of which the tool result carries — so we render a neutral "uses the default" note
  // rather than risk showing a prompt different from the one that will actually run.
  const customMessage = settings?.message ?? "";
  const hasCustomMessage = customMessage.length > 0;

  // Header pill — only once a successful result is in hand (live cadence green, paused
  // amber, cleared/not-set muted). Gating on `success` avoids confirming a state before
  // the tool has actually completed.
  let badge: { tone: BadgeTone; label: string } | null = null;
  if (success?.action === "unset") {
    badge = { tone: "cleared", label: "Cleared" };
  } else if (settings) {
    badge = settings.enabled
      ? { tone: "enabled", label: `Every ${formatHeartbeatIntervalShort(settings.intervalMs)}` }
      : { tone: "disabled", label: "Paused" };
  } else if (success?.action === "get") {
    badge = { tone: "cleared", label: "Not set" };
  }

  // Which detail block (if any) the resolved result drives. When none applies (and there's
  // no error) we fall back to the requested args — including while executing — so the
  // expanded body always shows what the agent is scheduling, never a blank panel.
  const hasResolvedDetail =
    Boolean(settings) || success?.action === "unset" || (success?.action === "get" && !settings);

  return (
    <ToolContainer expanded={expanded} className="@container">
      <ToolHeader onClick={toggleExpanded}>
        <ExpandIcon expanded={expanded}>▶</ExpandIcon>
        <ToolIcon toolName="heartbeat" />
        <span className="text-secondary font-medium whitespace-nowrap">{verb}</span>
        {badge && <HeartbeatBadge tone={badge.tone} label={badge.label} />}
        {summary && (
          <span className="text-foreground hidden truncate italic @sm:inline">{summary}</span>
        )}
        <StatusIndicator status={status}>{getStatusDisplay(status)}</StatusIndicator>
      </ToolHeader>

      {expanded && (
        <ToolDetails>
          {errorResult && <ErrorBox>{errorResult.error}</ErrorBox>}

          {settings && (
            <div className="bg-code-bg space-y-3 rounded px-3 py-2.5 text-[11px] leading-relaxed">
              <PulseTrace live={live} />

              <dl className="grid grid-cols-2 gap-x-6 gap-y-3">
                <HeartbeatStat
                  label="State"
                  value={
                    <span className={live ? "text-success" : "text-warning"}>
                      {live ? "Enabled" : "Paused"}
                    </span>
                  }
                />
                <HeartbeatStat
                  label="Cadence"
                  value={
                    <span className="counter-nums">
                      every {formatHeartbeatInterval(settings.intervalMs)}
                    </span>
                  }
                />
                <HeartbeatStat label="Context" value={ctx.label} />
                <HeartbeatStat
                  label="Trigger"
                  value={schedulePolicy.trigger === "interval" ? "Fixed interval" : "When idle"}
                />
              </dl>

              <div className="text-muted text-[10.5px] leading-relaxed">
                {ctx.blurb}.
                {live
                  ? schedulePolicy.trigger === "interval"
                    ? " Fires on a fixed schedule, regardless of activity."
                    : " Fires only after the workspace goes idle for the interval — deferred while you're actively working."
                  : " No check-ins will run until re-enabled."}
                {/* Surface a non-default when-busy delivery so the schedule is fully explained. */}
                {live && schedulePolicy.whenBusy === "tool-end"
                  ? " Queues after the current step when busy."
                  : live && schedulePolicy.whenBusy === "turn-end"
                    ? " Queues after the current turn when busy."
                    : null}
              </div>

              {hasCustomMessage ? (
                <div>
                  <div className="text-secondary mb-1 text-[10px] tracking-wide uppercase">
                    Check-in prompt
                  </div>
                  {/* Custom messages come from a multiline textarea and can contain long
                      URLs/paths — preserve newlines and break long tokens so the card never
                      overflows its container on narrow/mobile widths, as the generic
                      tool-output fallback did. */}
                  <div className="text-foreground border-l-2 border-white/10 pl-2.5 break-words whitespace-pre-wrap italic">
                    {customMessage}
                  </div>
                </div>
              ) : (
                <div className="text-muted text-[10.5px] italic">
                  Uses the default check-in prompt.
                </div>
              )}
            </div>
          )}

          {success?.action === "unset" && (
            <div className="text-muted px-3 py-2 text-[11px]">
              Recurring check-ins removed for this workspace.
            </div>
          )}

          {success?.action === "get" && !settings && (
            <div className="text-muted px-3 py-2 text-[11px] italic">
              No heartbeat is configured for this workspace.
            </div>
          )}

          {!errorResult && !hasResolvedDetail && <RequestedArgs args={props.args} />}

          {status === "executing" && (
            <div className="text-muted px-3 py-2 text-[11px] italic">
              Updating heartbeat settings…
            </div>
          )}
        </ToolDetails>
      )}
    </ToolContainer>
  );
};
