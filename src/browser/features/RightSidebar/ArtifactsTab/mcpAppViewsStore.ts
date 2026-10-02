import { useSyncExternalStore } from "react";
import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";
import { writeArtifactSelection } from "./artifactSelection";

/**
 * MCP Apps views opened from tool cards (artifacts experiment), per workspace, for the
 * Artifacts tab's "App views" picker group. Session-only: the view resource and result are
 * re-fetched from the backend whenever a view mounts.
 */
export interface McpAppViewRef {
  toolCallId: string;
  serverName: string;
  resourceUri: string;
  toolName: string;
  /** Tool title (or name) shown in the picker. */
  label: string;
  arguments: unknown;
  /** The call was interrupted or failed: the view gets tool-cancelled instead of a result. */
  cancelled: boolean;
}

/** Artifacts picker value for an app view; file paths never start with this prefix. */
export const MCP_APP_SELECTION_PREFIX = "mcp-app:";

export function mcpAppSelectionKey(toolCallId: string): string {
  return `${MCP_APP_SELECTION_PREFIX}${toolCallId}`;
}

const EMPTY: readonly McpAppViewRef[] = [];
const viewsByWorkspace = new Map<string, readonly McpAppViewRef[]>();
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getMcpAppViews(workspaceId: string): readonly McpAppViewRef[] {
  return viewsByWorkspace.get(workspaceId) ?? EMPTY;
}

export function useMcpAppViews(workspaceId: string): readonly McpAppViewRef[] {
  return useSyncExternalStore(subscribe, () => getMcpAppViews(workspaceId));
}

/**
 * Add (or refresh) a view, select it in the Artifacts tab, and ask the layout to reveal the
 * tab (OPEN_MCP_APP_VIEW).
 */
export function openMcpAppView(workspaceId: string, view: McpAppViewRef) {
  const current = getMcpAppViews(workspaceId).filter((v) => v.toolCallId !== view.toolCallId);
  viewsByWorkspace.set(workspaceId, [view, ...current]);
  emit();
  writeArtifactSelection(workspaceId, { path: mcpAppSelectionKey(view.toolCallId) });
  window.dispatchEvent(
    createCustomEvent(CUSTOM_EVENTS.OPEN_MCP_APP_VIEW, { workspaceId, toolCallId: view.toolCallId })
  );
}

export function closeMcpAppView(workspaceId: string, toolCallId: string) {
  const next = getMcpAppViews(workspaceId).filter((v) => v.toolCallId !== toolCallId);
  if (next.length === 0) viewsByWorkspace.delete(workspaceId);
  else viewsByWorkspace.set(workspaceId, next);
  emit();
}
