import React from "react";
import { Check, History, Pause, X } from "lucide-react";

import type { WorkflowRunRecord, WorkflowRunStatus } from "@/common/types/workflow";

import { stringifyWorkflowArgValue } from "./projectWorkflowRun";
import { WORKFLOW_STATUS_META, WORKFLOW_TONE_VAR, formatWorkflowTimeAgo } from "./workflowDisplay";

function primaryArgValue(args: unknown): string {
  if (args != null && typeof args === "object" && !Array.isArray(args)) {
    const values = Object.values(args as Record<string, unknown>);
    return values.length > 0 ? stringifyWorkflowArgValue(values[0]) : "";
  }
  return stringifyWorkflowArgValue(args);
}

const HistoryStatusIcon: React.FC<{ status: WorkflowRunStatus }> = (props) => {
  const color = WORKFLOW_TONE_VAR[WORKFLOW_STATUS_META[props.status].tone];
  if (props.status === "completed") {
    return <Check className="h-3.5 w-3.5 shrink-0" style={{ color }} />;
  }
  if (props.status === "failed") {
    return <X className="h-3.5 w-3.5 shrink-0" style={{ color }} />;
  }
  return <Pause className="h-3.5 w-3.5 shrink-0" style={{ color }} />;
};

interface WorkflowRunHistoryProps {
  runs: WorkflowRunRecord[];
  activeRunId: string | null;
  onOpen: (run: WorkflowRunRecord) => void;
}

/** Compact, clickable list of prior runs (everything but the focused run). */
export const WorkflowRunHistory: React.FC<WorkflowRunHistoryProps> = (props) => {
  if (props.runs.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-col gap-2 pt-1">
      <div className="text-muted flex items-center gap-1.5 text-[11px] font-semibold tracking-wide uppercase">
        <History className="h-3 w-3" /> Run history
      </div>
      <div className="flex flex-col gap-1">
        {props.runs.map((run) => {
          const isActive = run.id === props.activeRunId;
          return (
            <button
              key={run.id}
              type="button"
              onClick={() => props.onOpen(run)}
              className={`hover:bg-surface-secondary flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors ${
                isActive ? "border-border bg-surface-secondary" : "border-transparent"
              }`}
            >
              <HistoryStatusIcon status={run.status} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-content-primary truncate text-[12.5px] font-medium">
                  {run.workflow.name}
                </span>
                <span className="text-muted truncate text-[11px]">{primaryArgValue(run.args)}</span>
              </span>
              <span className="text-muted shrink-0 text-[11px]">
                {formatWorkflowTimeAgo(run.updatedAt)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
};
