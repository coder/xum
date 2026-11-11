import React, { useState } from "react";
import { ArrowDownToLine, Loader2, TriangleAlert } from "lucide-react";
import type { APIClient } from "@/browser/contexts/API";
import { Button } from "@/browser/components/Button/Button";
import { publishAgentPluginsMutated } from "@/browser/utils/agentPluginMutations";
import type {
  AgentPluginListItem,
  AgentPluginUpdateCheck,
  AgentPluginUpdateReview,
} from "@/common/orpc/schemas/agentPlugins";
import {
  summarizeRemaining,
  updateAllPlugins,
  type UpdateAllResult,
  type UpdateAllSummary,
} from "./updateAllPlugins";

type Reviews = readonly AgentPluginUpdateReview[];

/** The open review is the first; the rest wait behind it. */
export function useUpdateReviewQueue(initial: Reviews) {
  const [reviews, setReviews] = useState(initial);
  return {
    open: reviews[0] ?? null,
    waiting: reviews,
    show: (shown: Reviews) => setReviews(shown),
    next: () => setReviews((current) => current.slice(1)),
    clear: () => setReviews([]),
    // A plugin that is gone has no card to hold its review, so nothing could settle it.
    drop: (name: string) => setReviews((current) => current.filter((r) => r.name !== name)),
  };
}

interface UpdateAllDeps {
  api: APIClient | null;
  busyPlugin: string | null;
  setBusyPlugin: (name: string | null) => void;
  items: readonly AgentPluginListItem[] | null;
  updateChecks: ReadonlyMap<string, AgentPluginUpdateCheck>;
  /** The reviews this run left that still wait for the user. */
  waitingReviews: Reviews;
  onStart: () => void;
  onReviews: (reviews: Reviews) => void;
  refresh: () => Promise<void>;
  checkForUpdates: () => Promise<void>;
}

export function useUpdateAll(deps: UpdateAllDeps) {
  const [lastRun, setLastRun] = useState<UpdateAllResult | null>(null);
  const [running, setRunning] = useState(false);
  // Managed rows only, like the per-card Update: an unmanaged plugin in another container can
  // share a managed plugin's name.
  const checks = (deps.items ?? []).flatMap((item) =>
    item.managed ? (deps.updateChecks.get(item.name) ?? []) : []
  );
  const count = checks.filter((check) => check.status === "update-available").length;

  const run = async () => {
    if (!deps.api || deps.busyPlugin !== null) return;
    setRunning(true);
    setLastRun(null);
    deps.onStart();
    try {
      // The progress callback keeps `busyPlugin` set, which disables every per-card action.
      const result = await updateAllPlugins(deps.api, checks, deps.setBusyPlugin);
      if (result.updated.length > 0) {
        publishAgentPluginsMutated();
      }
      await deps.refresh();
      await deps.checkForUpdates();
      // Reviews and status appear together, in the render that also clears `busyPlugin`: a review
      // shown earlier could be confirmed or cancelled while the run still holds the busy state, and
      // the status written afterwards would describe a review that is already settled.
      deps.onReviews(result.reviews);
      setLastRun(result);
    } finally {
      deps.setBusyPlugin(null);
      setRunning(false);
    }
  };
  const status = lastRun === null ? null : summarizeRemaining(lastRun, deps.waitingReviews);
  return { count, running, status, run, dismissStatus: () => setLastRun(null) };
}

export const UpdateAllButton: React.FC<{
  count: number;
  running: boolean;
  disabled: boolean;
  onClick: () => void;
}> = (props) => {
  if (props.count === 0) return null;
  return (
    <Button variant="outline" size="sm" onClick={props.onClick} disabled={props.disabled}>
      {props.running ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <ArrowDownToLine className="h-3.5 w-3.5" />
      )}
      Update all ({props.count})
    </Button>
  );
};

export const UpdateAllStatus: React.FC<{ status: UpdateAllSummary | null }> = (props) => {
  if (props.status === null) return null;
  if (props.status.tone === "success") {
    return (
      <p role="status" className="text-accent-text mb-3 text-xs break-words">
        {props.status.message}
      </p>
    );
  }
  return (
    <div
      role="status"
      className="bg-warning/10 text-warning mb-3 flex items-start gap-2 rounded-md px-3 py-2 text-sm"
    >
      <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
      <span className="min-w-0 break-words">{props.status.message}</span>
    </div>
  );
};
