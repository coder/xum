import React from "react";
import { ChevronLeft } from "lucide-react";

import { useAPI } from "@/browser/contexts/API";
import type { AvailableWorkflow } from "@/common/types/workflow";

import { WorkflowEmptyState } from "./WorkflowEmptyState";
import { WorkflowRunHeader } from "./WorkflowRunHeader";
import { WorkflowRunHistory } from "./WorkflowRunHistory";
import { WorkflowTimeline } from "./WorkflowTimeline";
import { projectWorkflowRun, selectPrimaryWorkflowRun } from "./projectWorkflowRun";
import { useWorkflowRuns } from "./useWorkflowRuns";

/**
 * Right-sidebar Workflows tab: a live, scannable view of the workspace's
 * durable workflow runs. Focuses the most recent active run by default; the
 * run-history list lets the user pin any prior run into focus.
 */
export const WorkflowsTab: React.FC<{ workspaceId: string }> = (props) => {
  const { api } = useAPI();
  const { runs, loading, error } = useWorkflowRuns(props.workspaceId);
  const [overrideRunId, setOverrideRunId] = React.useState<string | null>(null);
  const [scripts, setScripts] = React.useState<AvailableWorkflow[]>([]);
  const [busyScriptPath, setBusyScriptPath] = React.useState<string | null>(null);
  const [runError, setRunError] = React.useState<string | null>(null);

  // Discover runnable scripts for the empty-state list (one per workspace).
  React.useEffect(() => {
    // Reset launcher state first so a workspace switch never shows or launches a stale script
    // from the previous workspace — including if the new fetch is still pending or fails.
    setScripts([]);
    setBusyScriptPath(null);
    setRunError(null);
    if (api == null) {
      return;
    }
    let ignore = false;
    api.workflows
      .listScripts({ workspaceId: props.workspaceId })
      .then((result) => {
        if (!ignore) {
          setScripts(result);
        }
      })
      .catch(() => {
        // Non-fatal: the empty state still renders, just without the script list.
      });
    return () => {
      ignore = true;
    };
  }, [api, props.workspaceId]);

  const runScript = async (script: AvailableWorkflow, args: Record<string, unknown>) => {
    if (api == null || busyScriptPath != null) {
      return;
    }
    setBusyScriptPath(script.scriptPath);
    setRunError(null);
    try {
      await api.workflows.start({
        workspaceId: props.workspaceId,
        scriptPath: script.scriptPath,
        args,
        // Background the launch so the call returns immediately; the run then streams
        // into the tab via the subscription and becomes the focused run.
        runInBackground: true,
      });
      setOverrideRunId(null);
    } catch (startError) {
      setRunError(startError instanceof Error ? startError.message : "Failed to start workflow");
    } finally {
      setBusyScriptPath(null);
    }
  };

  if (error != null) {
    return <div className="text-danger text-sm">Failed to load workflows: {error}</div>;
  }

  if (loading && runs.length === 0) {
    return <div className="text-muted text-sm">Loading workflow runs…</div>;
  }

  if (runs.length === 0) {
    return (
      <div className="flex flex-col gap-2">
        {runError != null && <div className="text-danger text-xs">{runError}</div>}
        <WorkflowEmptyState
          scripts={scripts}
          onRun={(script, args) => void runScript(script, args)}
          busyScriptPath={busyScriptPath}
        />
      </div>
    );
  }

  const overrideRun =
    overrideRunId != null ? (runs.find((run) => run.id === overrideRunId) ?? null) : null;
  const focusedRun = overrideRun ?? selectPrimaryWorkflowRun(runs);
  const view = focusedRun != null ? projectWorkflowRun(focusedRun) : null;
  const historyRuns = focusedRun != null ? runs.filter((run) => run.id !== focusedRun.id) : runs;

  return (
    <div className="flex flex-col gap-4">
      {overrideRun != null && (
        <button
          type="button"
          onClick={() => setOverrideRunId(null)}
          className="border-border bg-surface-secondary text-content-secondary hover:bg-hover inline-flex w-fit items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors"
        >
          <ChevronLeft className="h-3 w-3" /> Back to current run
        </button>
      )}

      {focusedRun != null && view != null && (
        // Key by run id so switching runs gives the header/timeline fresh state — otherwise a
        // prior run's action error or a same-named failed phase's collapsed disclosure state
        // would carry over (and useDisclosureOpenOnFailure wouldn't auto-open the new failure).
        <React.Fragment key={focusedRun.id}>
          <WorkflowRunHeader
            workspaceId={props.workspaceId}
            run={focusedRun}
            view={view}
            onAfterAction={() => setOverrideRunId(null)}
          />
          <WorkflowTimeline view={view} workspaceId={props.workspaceId} />
        </React.Fragment>
      )}

      {runError != null && <div className="text-danger text-xs">{runError}</div>}

      <WorkflowRunHistory
        runs={historyRuns}
        activeRunId={overrideRun?.id ?? null}
        onOpen={(run) => setOverrideRunId(run.id)}
      />
    </div>
  );
};
