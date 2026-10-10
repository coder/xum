import { useEffect, useState } from "react";
import { useAPI } from "@/browser/contexts/API";
import { subscribeAgentPluginsMutated } from "@/browser/utils/agentPluginMutations";
import type { McpAppPluginView } from "@/common/orpc/schemas/mcpApps";

/** A workspace's plugin views; the workspace ID keeps a stale list from showing elsewhere. */
export interface WorkspacePluginViews {
  workspaceId: string;
  views: readonly McpAppPluginView[];
}

/**
 * The plugin views (`contributes.views`) of a workspace, for the command palette and the
 * Artifacts picker. Re-listed when the workspace changes and after a plugin install, update
 * or removal. Listing is best effort: on failure the workspace shows no plugin views. The
 * `enabled` flag can go stale; opening a view re-checks it in the backend.
 */
export function usePluginViews(
  workspaceId: string | null,
  enabled: boolean
): WorkspacePluginViews | null {
  const { api } = useAPI();
  const [loaded, setLoaded] = useState<WorkspacePluginViews | null>(null);
  const [mutationTick, setMutationTick] = useState(0);

  useEffect(() => subscribeAgentPluginsMutated(() => setMutationTick((tick) => tick + 1)), []);

  useEffect(() => {
    if (!api || workspaceId == null || !enabled) return;
    const controller = new AbortController();
    api.mcpApps
      .listPluginViews({ workspaceId }, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        setLoaded({ workspaceId, views: result.success ? result.data : [] });
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoaded({ workspaceId, views: [] });
      });
    return () => controller.abort();
  }, [api, workspaceId, enabled, mutationTick]);

  return enabled && loaded?.workspaceId === workspaceId ? loaded : null;
}
