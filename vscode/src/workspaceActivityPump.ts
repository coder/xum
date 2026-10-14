import assert from "node:assert";

import type { WorkspaceActivitySnapshot } from "xum/common/types/workspace";
import type { UiWorkspaceActivity } from "./webview/protocol";

type ActivityFields = Partial<
  Pick<WorkspaceActivitySnapshot, "activeBashMonitorCount" | "streaming" | "activeWorkflowRunIds">
> & { transientGoalOnly?: boolean };

/** The slice of the oRPC client the pump uses; ApiClient satisfies it structurally. */
export interface WorkspaceActivityPumpClient {
  workspace: {
    activity: {
      subscribe(
        input: undefined,
        options: { signal: AbortSignal }
      ): Promise<
        AsyncIterable<
          | { type: "activity"; workspaceId: string; activity: ActivityFields | null }
          | { type: "heartbeat" }
        >
      >;
      list(): Promise<Record<string, ActivityFields> | null>;
    };
  };
}

function toUiActivity(activity: ActivityFields | null | undefined): UiWorkspaceActivity {
  return {
    activeBashMonitorCount: activity?.activeBashMonitorCount ?? 0,
    streaming: activity?.streaming ?? false,
    activeWorkflowRunIds: activity?.activeWorkflowRunIds ?? [],
  };
}

/**
 * Forwards the activity of the selected workspace (#4971) and its descendants (#5109); the host
 * restarts it when that set changes. Lives outside extension.ts (which imports `vscode`) so it
 * can be unit tested (#5002).
 * Best-effort: failures before abort go to `onError`, never to a notice.
 */
export async function pumpWorkspaceActivity(params: {
  client: WorkspaceActivityPumpClient;
  /** The selected workspace first, then its descendants. */
  workspaceIds: readonly string[];
  signal: AbortSignal;
  /** False once the view selects another workspace; posts stop then. */
  isSelected: () => boolean;
  post: (activity: Record<string, UiWorkspaceActivity>) => void;
  onError: (error: unknown) => void;
}): Promise<void> {
  const { client, workspaceIds, signal } = params;
  assert(workspaceIds.length > 0, "pumpWorkspaceActivity requires a workspace");
  const tracked = new Set(workspaceIds);

  // Activity events fire for every snapshot change; only a changed slice is worth a message.
  const latest: Record<string, UiWorkspaceActivity> = {};
  let lastPostedKey: string | null = null;
  const post = () => {
    const key = JSON.stringify(latest);
    if (signal.aborted || !params.isSelected() || key === lastPostedKey) {
      return;
    }
    lastPostedKey = key;
    params.post({ ...latest });
  };

  try {
    // Subscribe before the snapshot so no change between them is lost.
    const iterator = await client.workspace.activity.subscribe(undefined, { signal });
    const snapshots = await client.workspace.activity.list();
    // null means the backend could not read activity; keep the webview's current values.
    if (snapshots) {
      for (const workspaceId of workspaceIds) {
        latest[workspaceId] = toUiActivity(snapshots[workspaceId]);
      }
      post();
    }

    for await (const event of iterator) {
      // Goal-only events carry stale baseline fields; they never change these.
      if (
        event.type !== "activity" ||
        !tracked.has(event.workspaceId) ||
        event.activity?.transientGoalOnly === true
      ) {
        continue;
      }
      latest[event.workspaceId] = toUiActivity(event.activity);
      post();
    }
  } catch (error) {
    if (signal.aborted) {
      return;
    }
    params.onError(error);
  }
}
