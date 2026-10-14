import { useEffect, useState, useSyncExternalStore } from "react";
import { useAPI, type APIClient } from "@/browser/contexts/API";
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
/** Workspaces whose loader is listing (or re-listing) their entry points. */
const pendingWorkspaces = new Set<string>();
const listeners = new Set<() => void>();

const refKey = (workspaceId: string, viewKey: string) => `${workspaceId}\u0000${viewKey}`;

/**
 * The view ref of each entry point listed this session (by workspace and view key). One ref per
 * entry point keeps its identity across re-lists (views compare by identity in McpAppFrame), and
 * a re-list keeps showing it until the new list settles. A settled list without it drops it and
 * retires the key: its tab then shows unavailable, never a stored record.
 */
const viewRefs = new Map<string, McpAppViewRef>();
const retiredKeys = new Set<string>();

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

/**
 * The line under an entry point's title (launcher row, palette subtitle): its server label
 * first, so a narrow row keeps it before the ellipsis, then " · this chat" for a `thread` entry
 * point, so a tool with both types does not show two identical rows.
 */
export function mcpAppEntrypointDescription(entrypoint: McpAppEntrypoint): string {
  return withEntrypointScope(entrypoint.serverLabel, entrypoint.type);
}

/** `text`, then " · this chat" for a `thread` entry point (rows, palette, app tabs). */
export function withEntrypointScope(
  text: string,
  type: McpAppEntrypoint["type"] | undefined
): string {
  return type === "thread" ? `${text} · this chat` : text;
}

/** Publish a settled list, or `"pending"` while it is being listed. */
function setMcpAppEntrypoints(workspaceId: string, list: readonly McpAppEntrypoint[] | "pending") {
  if (list === "pending") {
    entrypointsByWorkspace.delete(workspaceId);
    pendingWorkspaces.add(workspaceId);
    emit();
    return;
  }
  entrypointsByWorkspace.set(workspaceId, list);
  pendingWorkspaces.delete(workspaceId);
  const listed = new Set(list.map((entrypoint) => refKey(workspaceId, entrypoint.viewKey)));
  for (const key of listed) retiredKeys.delete(key);
  for (const key of viewRefs.keys()) {
    if (key.startsWith(refKey(workspaceId, "")) && !listed.has(key)) {
      viewRefs.delete(key);
      retiredKeys.add(key);
    }
  }
  emit();
}

/** An open returned the entry point as it is now (its view may have moved): list that one. */
function updateMcpAppEntrypoint(workspaceId: string, entrypoint: McpAppEntrypoint) {
  const list = entrypointsByWorkspace.get(workspaceId);
  if (list === undefined) return;
  setMcpAppEntrypoints(workspaceId, [
    ...list.filter((listed) => listed.viewKey !== entrypoint.viewKey),
    entrypoint,
  ]);
}

/** The fields of an entry point's view ref that come from its entry point. */
const REF_FIELDS = [
  "serverName",
  "serverLabel",
  "resourceUri",
  "toolName",
  "label",
  "entrypointType",
] as const satisfies ReadonlyArray<keyof McpAppViewRef>;

/** The view an entry point's app tab shows: its stored record is keyed by `viewKey`. */
export function entrypointViewRef(
  workspaceId: string,
  entrypoint: McpAppEntrypoint
): McpAppViewRef {
  const key = refKey(workspaceId, entrypoint.viewKey);
  const known = viewRefs.get(key);
  const ref: McpAppViewRef = {
    toolCallId: entrypoint.viewKey,
    serverName: entrypoint.serverName,
    serverLabel: entrypoint.serverLabel,
    resourceUri: entrypoint.resourceUri,
    toolName: entrypoint.toolName,
    label: entrypoint.title,
    arguments: {},
    cancelled: false,
    failed: false,
    entrypointType: entrypoint.type,
  };
  // Keep the known ref while it shows the same view (no arguments or outcome to compare).
  if (known !== undefined && REF_FIELDS.every((field) => known[field] === ref[field])) return known;
  viewRefs.set(key, ref);
  return ref;
}

/** Record a successful open: the backend's answer is what the tab shows. */
export function openedMcpAppEntrypoint(
  workspaceId: string,
  entrypoint: McpAppEntrypoint
): McpAppViewRef {
  const ref = entrypointViewRef(workspaceId, entrypoint);
  updateMcpAppEntrypoint(workspaceId, entrypoint);
  return ref;
}

/**
 * What an app tab key resolves to as an entry point: its view, null once a settled list lacks
 * it, "loading" while the list is pending, or undefined when it is not one (any key a settled
 * list lacks and never listed: an ordinary tool call, whatever its text). Membership in the
 * list decides, never the key's text: tool call IDs come from outside.
 */
export function mcpAppEntrypointViewOf(
  workspaceId: string,
  viewKey: string
): McpAppViewRef | null | "loading" | undefined {
  if (retiredKeys.has(refKey(workspaceId, viewKey))) return null;
  const list = entrypointsByWorkspace.get(workspaceId);
  const listed = list?.find((entrypoint) => entrypoint.viewKey === viewKey);
  if (listed !== undefined) return entrypointViewRef(workspaceId, listed);
  if (list !== undefined || !pendingWorkspaces.has(workspaceId)) return undefined;
  return viewRefs.get(refKey(workspaceId, viewKey)) ?? "loading";
}

export function useMcpAppEntrypointView(
  workspaceId: string,
  viewKey: string
): McpAppViewRef | null | "loading" | undefined {
  return useSyncExternalStore(subscribe, () => mcpAppEntrypointViewOf(workspaceId, viewKey));
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
    if (workspaceId == null) return;
    return loadMcpAppEntrypoints(api, workspaceId, enabled);
  }, [api, workspaceId, enabled, mutationTick]);
}

/** One listing into the store; returns its cancel (which also ends the pending state). */
function loadMcpAppEntrypoints(
  api: APIClient | null,
  workspaceId: string,
  enabled: boolean
): (() => void) | undefined {
  // Off: none, settled at once, so a restored entry point tab does not wait forever.
  if (!enabled) {
    setMcpAppEntrypoints(workspaceId, []);
    return;
  }
  if (!api) return;
  setMcpAppEntrypoints(workspaceId, "pending");
  const controller = new AbortController();
  // Through a resolved promise, so a client that throws synchronously (disconnected, disposed)
  // also settles the list empty instead of throwing out of the effect.
  Promise.resolve()
    .then(() => api.mcpApps.listEntrypoints({ workspaceId }, { signal: controller.signal }))
    .then((list) => {
      if (!controller.signal.aborted) setMcpAppEntrypoints(workspaceId, list);
    })
    .catch(() => {
      if (!controller.signal.aborted) setMcpAppEntrypoints(workspaceId, []);
    });
  return () => {
    controller.abort();
    // Unloaded: this workspace's tabs resolve as ordinary views until it loads again.
    if (pendingWorkspaces.delete(workspaceId)) emit();
  };
}
