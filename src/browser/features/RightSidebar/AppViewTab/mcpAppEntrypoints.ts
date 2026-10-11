import { useEffect, useState, useSyncExternalStore } from "react";
import { useAPI } from "@/browser/contexts/API";
import { subscribeAgentPluginsMutated } from "@/browser/utils/agentPluginMutations";
import { subscribeWorkspaceMcpOverridesSaved } from "@/browser/utils/workspaceMcpMutations";
import type { McpAppEntrypoint } from "@/common/orpc/schemas/mcpApps";
import type { McpAppViewRef } from "../ArtifactsTab/mcpAppViewsStore";

/**
 * MCP App entry points (`_meta["openai/ui"].entrypoints`, artifacts experiment) of the selected
 * workspace, for the New tab launcher, the command palette and app tabs restored after a
 * reload. App mounts the loader once; every consumer reads this store.
 */
const entrypointsByWorkspace = new Map<string, readonly McpAppEntrypoint[]>();
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The workspace's entry points; undefined until listed (or while a re-list is pending). */
export function getMcpAppEntrypoints(workspaceId: string): readonly McpAppEntrypoint[] | undefined {
  return entrypointsByWorkspace.get(workspaceId);
}

export function useMcpAppEntrypoints(workspaceId: string): readonly McpAppEntrypoint[] | undefined {
  return useSyncExternalStore(subscribe, () => getMcpAppEntrypoints(workspaceId));
}

function setMcpAppEntrypoints(workspaceId: string, list: readonly McpAppEntrypoint[] | undefined) {
  if (list === undefined) entrypointsByWorkspace.delete(workspaceId);
  else entrypointsByWorkspace.set(workspaceId, list);
  emit();
}

// One ref per listed entry point: views compare by identity across renders (McpAppFrame).
const viewRefs = new WeakMap<McpAppEntrypoint, McpAppViewRef>();

/** The view an entry point's app tab shows: its stored record is keyed by `viewKey`. */
export function entrypointViewRef(entrypoint: McpAppEntrypoint): McpAppViewRef {
  const known = viewRefs.get(entrypoint);
  if (known !== undefined) return known;
  const ref: McpAppViewRef = {
    toolCallId: entrypoint.viewKey,
    serverName: entrypoint.serverName,
    resourceUri: entrypoint.resourceUri,
    toolName: entrypoint.toolName,
    label: entrypoint.title,
    arguments: {},
    cancelled: false,
    failed: false,
  };
  viewRefs.set(entrypoint, ref);
  return ref;
}

/**
 * List the workspace's entry points into the store. Re-listed when the workspace changes,
 * after a plugin install, update or uninstall, and after an MCP enable or disable or a project
 * trust change (entry points exist only for enabled servers). Salvaged from #6041's
 * usePluginViews: an invalidation clears the list first, so a stale entry never outlives the
 * change. Best effort: a failed listing shows no entry points.
 */
export function useLoadMcpAppEntrypoints(workspaceId: string | null, enabled: boolean): void {
  const { api } = useAPI();
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

  // Syncs an external store with the backend (not derived React state).
  useEffect(() => {
    if (!api || workspaceId == null) return;
    setMcpAppEntrypoints(workspaceId, undefined);
    if (!enabled) return;
    const controller = new AbortController();
    api.mcpApps
      .listEntrypoints({ workspaceId }, { signal: controller.signal })
      .then((list) => {
        if (!controller.signal.aborted) setMcpAppEntrypoints(workspaceId, list);
      })
      .catch(() => {
        if (!controller.signal.aborted) setMcpAppEntrypoints(workspaceId, []);
      });
    return () => controller.abort();
  }, [api, workspaceId, enabled, mutationTick]);
}
