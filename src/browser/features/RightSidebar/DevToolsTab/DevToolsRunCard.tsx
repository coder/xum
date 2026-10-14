import { useEffect, useState } from "react";
import { AlertCircle, ChevronRight, Loader2 } from "lucide-react";
import { useAPI, type APIClient } from "@/browser/contexts/API";
import { isConnectionLostError } from "@/browser/contexts/connectionLink";
import { cn } from "@/common/lib/utils";
import type { DevToolsRunSummary, DevToolsStep } from "@/common/types/devtools";
import { formatDuration } from "@/common/utils/formatDuration";
import { DevToolsStepCard } from "./DevToolsStepCard";

interface DevToolsRunCardProps {
  run: DevToolsRunSummary;
  workspaceId: string;
  liveSteps?: DevToolsStep[];
}

type RunDetailRead =
  | { status: "ok"; steps: DevToolsStep[] }
  | { status: "error"; error: string }
  /** Cut off by a lost connection (ConnectionLostError): not an error, the next client retries. */
  | { status: "lost" };

async function readRunDetail(
  api: APIClient,
  workspaceId: string,
  runId: string
): Promise<RunDetailRead> {
  try {
    const result = await api.devtools.getRunDetail({ workspaceId, runId });
    return { status: "ok", steps: result?.steps ?? [] };
  } catch (error: unknown) {
    if (isConnectionLostError(error)) return { status: "lost" };
    return {
      status: "error",
      error: error instanceof Error ? error.message : "Failed to load run detail",
    };
  }
}

/**
 * The run's steps, read while the card is expanded and has none yet. A read cut off by a lost
 * connection keeps the spinner, and the next client (a new `api`: the runs list stays mounted
 * across a reconnect) reads it again instead of the card keeping a connection error.
 */
function useRunDetail(expanded: boolean, workspaceId: string, runId: string) {
  const { api } = useAPI();
  const [steps, setSteps] = useState<DevToolsStep[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const needsDetail = expanded && steps === null;
  useEffect(() => {
    if (!needsDetail || !api) {
      return;
    }
    let cancelled = false;
    setError(null);
    void readRunDetail(api, workspaceId, runId).then((read) => {
      if (cancelled || read.status === "lost") return;
      if (read.status === "ok") {
        setSteps(read.steps);
      } else {
        setError(read.error);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [api, needsDetail, workspaceId, runId]);

  return { steps, error };
}

export function DevToolsRunCard(props: DevToolsRunCardProps) {
  const [expanded, setExpanded] = useState(false);
  const { steps, error } = useRunDetail(expanded, props.workspaceId, props.run.id);
  const displaySteps = mergeDisplaySteps(steps, props.liveSteps);

  const handleToggle = () => {
    setExpanded(!expanded);
  };

  return (
    <div className="border-border-light bg-background-secondary min-w-0 rounded border">
      <button
        type="button"
        onClick={handleToggle}
        className="hover:bg-hover flex w-full min-w-0 items-center gap-2 px-2 py-1.5 text-left"
      >
        <ChevronRight
          className={cn("h-3 w-3 shrink-0 transition-transform", expanded && "rotate-90")}
        />
        <span className="text-foreground flex-1 truncate text-xs">
          {props.run.firstMessage || "\u2014"}
        </span>
        {props.run.modelId && (
          <span className="text-muted min-w-0 truncate text-[10px]">{props.run.modelId}</span>
        )}
        <span className="text-muted shrink-0 text-[10px]">
          {props.run.stepCount} step{props.run.stepCount !== 1 ? "s" : ""}
        </span>
        {props.run.totalDurationMs != null && (
          <span className="text-muted shrink-0 text-[10px]">
            {formatDuration(props.run.totalDurationMs, "precise")}
          </span>
        )}
        {props.run.isInProgress && <Loader2 className="text-muted h-3 w-3 shrink-0 animate-spin" />}
        {props.run.hasError && <AlertCircle className="text-destructive h-3 w-3 shrink-0" />}
      </button>

      {expanded && (
        <div className="border-border-light min-w-0 border-t px-2 py-1.5">
          {/* No steps and no error: the detail is loading, or waits for a client (it loads
              once Xum reconnects), so this never claims "No steps recorded" too early. */}
          {steps === null && error === null ? (
            <div className="flex justify-center py-2">
              <Loader2 className="text-muted h-4 w-4 animate-spin" />
            </div>
          ) : error && steps === null ? (
            <p className="text-destructive py-1 text-[10px]">{error}</p>
          ) : displaySteps && displaySteps.length > 0 ? (
            <div className="flex min-w-0 flex-col gap-1">
              {displaySteps.map((step) => (
                <DevToolsStepCard key={step.id} step={step} toolPolicy={props.run.toolPolicy} />
              ))}
            </div>
          ) : (
            <p className="text-muted py-1 text-[10px]">No steps recorded</p>
          )}
        </div>
      )}
    </div>
  );
}

function mergeDisplaySteps(
  fetchedSteps: DevToolsStep[] | null,
  liveSteps: DevToolsStep[] | undefined
): DevToolsStep[] | null {
  // Live events can arrive after the initial snapshot, so they may only represent
  // the currently changing subset of steps. Preserve fetched history and overlay
  // live updates by step ID.
  if (fetchedSteps == null && liveSteps == null) {
    return null;
  }

  if (fetchedSteps == null) {
    return sortSteps(liveSteps ?? []);
  }

  if (liveSteps == null || liveSteps.length === 0) {
    return sortSteps(fetchedSteps);
  }

  const stepsById = new Map(fetchedSteps.map((step) => [step.id, step] as const));
  for (const liveStep of liveSteps) {
    stepsById.set(liveStep.id, liveStep);
  }

  return sortSteps([...stepsById.values()]);
}

function sortSteps(steps: DevToolsStep[]): DevToolsStep[] {
  return [...steps].sort((left, right) => left.stepNumber - right.stepNumber);
}
