import React from "react";
import { Check, Circle, Pause, X, type LucideIcon } from "lucide-react";

import type { WorkflowRunStatus, WorkflowScriptScope } from "@/common/types/workflow";
import { WORKFLOW_STATUS_META, WORKFLOW_TONE_VAR, type WorkflowTone } from "./workflowDisplay";

/** Small pulsing dot used to mark live / running work. */
export const WorkflowLiveDot: React.FC<{ tone?: WorkflowTone; className?: string }> = (props) => (
  <span
    className={`inline-block h-[7px] w-[7px] shrink-0 animate-pulse rounded-full motion-reduce:animate-none ${props.className ?? ""}`}
    style={{ background: WORKFLOW_TONE_VAR[props.tone ?? "running"] }}
    aria-hidden="true"
  />
);

// Status → glyph. Exhaustive over WorkflowRunStatus (via Record) so adding a run status
// is a compile error here rather than a silent fall-through to the default icon.
const WORKFLOW_STATUS_ICON: Record<WorkflowRunStatus, LucideIcon> = {
  pending: Circle,
  running: Circle,
  backgrounded: Pause,
  interrupted: Pause,
  completed: Check,
  failed: X,
};

const WorkflowStatusIcon: React.FC<{ status: WorkflowRunStatus; color: string }> = (props) => {
  const Icon = WORKFLOW_STATUS_ICON[props.status];
  return <Icon className="h-3 w-3 shrink-0" style={{ color: props.color }} />;
};

/** Run status pill — colored by status tone; pulses while running. */
export const WorkflowStatusPill: React.FC<{ status: WorkflowRunStatus; pulse?: boolean }> = (
  props
) => {
  const meta = WORKFLOW_STATUS_META[props.status];
  const color = WORKFLOW_TONE_VAR[meta.tone];
  const isLive = props.status === "running";
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap"
      style={{
        color,
        borderColor: `color-mix(in srgb, ${color} 35%, transparent)`,
        background: `color-mix(in srgb, ${color} 12%, transparent)`,
      }}
    >
      {isLive && props.pulse !== false ? (
        <WorkflowLiveDot tone={meta.tone} />
      ) : (
        <WorkflowStatusIcon status={props.status} color={color} />
      )}
      {meta.label}
    </span>
  );
};

/** Where the workflow script came from. */
export const WorkflowScopeBadge: React.FC<{ scope: WorkflowScriptScope }> = (props) => (
  <span className="border-border text-muted rounded border px-1.5 py-px text-[9.5px] font-semibold tracking-wide uppercase">
    {props.scope}
  </span>
);
