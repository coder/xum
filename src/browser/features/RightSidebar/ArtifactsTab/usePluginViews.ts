import { useEffect, useState } from "react";
import { useAPI } from "@/browser/contexts/API";
import { subscribeAgentPluginsMutated } from "@/browser/utils/agentPluginMutations";
import { subscribeWorkspaceMcpOverridesSaved } from "@/browser/utils/workspaceMcpMutations";
import type { McpAppPluginView } from "@/common/orpc/schemas/mcpApps";

/** A workspace's plugin views; the workspace ID keeps a stale list from showing elsewhere. */
export interface WorkspacePluginViews {
  workspaceId: string;
  /**
   * Bumps on every invalidation (plugin install/update/removal, MCP enablement, project trust).
   * A list is returned only for the current generation, so after an invalidation the caller sees
   * null until the fresh list arrives: stale entries and frames never outlive the change.
   */
  generation: number;
  views: readonly McpAppPluginView[];
}

/**
 * The plugin views (`contributes.views`) of a workspace, for the command palette and the
 * Artifacts picker. Re-listed when the workspace changes, after a plugin install, update or
 * removal, and after this workspace's MCP configuration is saved or a global MCP server is
 * toggled (a view's `enabled` flag follows its server). Listing is best effort: on failure the workspace shows no plugin views.
 * Opening a view still re-checks the server in the backend.
 */
export function usePluginViews(
  workspaceId: string | null,
  enabled: boolean
): WorkspacePluginViews | null {
  const { api } = useAPI();
  const [loaded, setLoaded] = useState<WorkspacePluginViews | null>(null);
  const [mutationTick, setMutationTick] = useState(0);

  useEffect(() => subscribeAgentPluginsMutated(() => setMutationTick((tick) => tick + 1)), []);
  useEffect(
    () =>
      subscribeWorkspaceMcpOverridesSaved((savedWorkspaceId) => {
        if (savedWorkspaceId === null || savedWorkspaceId === workspaceId) {
          setMutationTick((tick) => tick + 1);
        }
      }),
    [workspaceId]
  );

  useEffect(() => {
    if (!api || workspaceId == null || !enabled) return;
    const controller = new AbortController();
    api.mcpApps
      .listPluginViews({ workspaceId }, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        setLoaded({
          workspaceId,
          generation: mutationTick,
          views: result.success ? result.data : [],
        });
      })
      .catch(() => {
        // A failed listing shows no views; it never revives an older list.
        if (!controller.signal.aborted) {
          setLoaded({ workspaceId, generation: mutationTick, views: [] });
        }
      });
    return () => controller.abort();
  }, [api, workspaceId, enabled, mutationTick]);

  return enabled && loaded?.workspaceId === workspaceId && loaded.generation === mutationTick
    ? loaded
    : null;
}
