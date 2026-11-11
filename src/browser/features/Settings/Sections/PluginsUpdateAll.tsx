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
import { summarizeUpdateAll, updateAllPlugins, type UpdateAllSummary } from "./updateAllPlugins";

type Reviews = readonly AgentPluginUpdateReview[];

/** The update review the section shows, and the ones waiting behind it (Update all can find several). */
interface ReviewQueue {
  open: AgentPluginUpdateReview | null;
  queued: Reviews;
}

const queueOf = (reviews: Reviews): ReviewQueue => ({
  open: reviews[0] ?? null,
  queued: reviews.slice(1),
});

export function useUpdateReviewQueue(initial: Reviews) {
  const [queue, setQueue] = useState(() => queueOf(initial));
  return {
    open: queue.open,
    /** Replaces the open review and everything queued behind it. */
    show: (reviews: Reviews) => setQueue(queueOf(reviews)),
    /** The open review was confirmed or cancelled: the next queued one opens. */
    next: () => setQueue((current) => queueOf(current.queued)),
    clear: () => setQueue(queueOf([])),
  };
}

interface UpdateAllDeps {
  api: APIClient | null;
  /** Name of the plugin with an action in flight; Update all holds it for the whole run. */
  busyPlugin: string | null;
  setBusyPlugin: (name: string | null) => void;
  items: readonly AgentPluginListItem[] | null;
  updateChecks: ReadonlyMap<string, AgentPluginUpdateCheck>;
  /** Called before a run: an open review would confirm against a tree this run moves. */
  onStart: () => void;
  onReviews: (reviews: Reviews) => void;
  refresh: () => Promise<void>;
  checkForUpdates: () => Promise<void>;
}

export function useUpdateAll(deps: UpdateAllDeps) {
  const [status, setStatus] = useState<UpdateAllSummary | null>(null);
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
    setStatus(null);
    deps.onStart();
    try {
      // The progress callback keeps `busyPlugin` set, which disables every per-card action.
      const result = await updateAllPlugins(deps.api, checks, deps.setBusyPlugin);
      if (result.updated.length > 0) {
        // Mounted composers cache contributed slash-command/skill descriptors; an update can
        // change them without a remount.
        publishAgentPluginsMutated();
      }
      deps.onReviews(result.reviews);
      await deps.refresh();
      await deps.checkForUpdates();
      setStatus(summarizeUpdateAll(result));
    } finally {
      deps.setBusyPlugin(null);
      setRunning(false);
    }
  };
  return { count, running, status, run };
}

/** Shown only while a managed plugin has an update waiting. */
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

/** What the last Update all did, including what it left for the user. */
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
