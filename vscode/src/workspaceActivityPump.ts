import assert from "node:assert";

import type { WorkspaceActivitySnapshot } from "xum/common/types/workspace";

type ActivityCount = Pick<WorkspaceActivitySnapshot, "activeBashMonitorCount">;

/** The slice of the oRPC client the pump uses; ApiClient satisfies it structurally. */
export interface WorkspaceActivityPumpClient {
  workspace: {
    activity: {
      subscribe(
        input: undefined,
        options: { signal: AbortSignal }
      ): Promise<
        AsyncIterable<
          | { type: "activity"; workspaceId: string; activity: ActivityCount | null }
          | { type: "heartbeat" }
        >
      >;
      list(): Promise<Record<string, ActivityCount> | null>;
    };
  };
}

/**
 * Forwards one workspace's armed bash-monitor count (#4971): the webview barrier's
 * waiting-on-monitor phase needs it, and only the activity feed carries it. Lives outside
 * extension.ts (which imports `vscode`) so it can be unit tested (#5002).
 * Best-effort: failures before abort go to `onError`, never to a notice.
 */
export async function pumpWorkspaceActivity(params: {
  client: WorkspaceActivityPumpClient;
  workspaceId: string;
  signal: AbortSignal;
  /** False once the view selects another workspace; posts stop then. */
  isSelected: () => boolean;
  post: (activeBashMonitorCount: number) => void;
  onError: (error: unknown) => void;
}): Promise<void> {
  const { client, workspaceId, signal } = params;
  assert(workspaceId.length > 0, "pumpWorkspaceActivity requires workspaceId");

  // Activity events fire for every snapshot change; only a changed count is worth a message.
  let lastPosted: number | null = null;
  const post = (activeBashMonitorCount: number) => {
    if (signal.aborted || !params.isSelected() || activeBashMonitorCount === lastPosted) {
      return;
    }
    lastPosted = activeBashMonitorCount;
    params.post(activeBashMonitorCount);
  };

  try {
    // Subscribe before the snapshot so no change between them is lost.
    const iterator = await client.workspace.activity.subscribe(undefined, { signal });
    const snapshots = await client.workspace.activity.list();
    // null means the backend could not read activity; keep the webview's current value.
    if (snapshots) {
      post(snapshots[workspaceId]?.activeBashMonitorCount ?? 0);
    }

    for await (const event of iterator) {
      if (event.type === "activity" && event.workspaceId === workspaceId) {
        post(event.activity?.activeBashMonitorCount ?? 0);
      }
    }
  } catch (error) {
    if (signal.aborted) {
      return;
    }
    params.onError(error);
  }
}
