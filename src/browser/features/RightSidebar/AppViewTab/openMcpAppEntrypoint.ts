import type { APIClient } from "@/browser/contexts/API";
import { readPersistedState } from "@/browser/hooks/usePersistedState";
import { collectAllTabs, parseRightSidebarLayoutState } from "@/browser/utils/rightSidebarLayout";
import { getRightSidebarLayoutKey } from "@/common/constants/storage";
import type { McpAppEntrypoint } from "@/common/orpc/schemas/mcpApps";
import { getErrorMessage } from "@/common/utils/errors";
import { focusMcpAppViewTab, type McpAppViewRef } from "../ArtifactsTab/mcpAppViewsStore";
import { appViewTabFor } from "./appViewTabs";
import { entrypointViewRef, openedMcpAppEntrypoint } from "./mcpAppEntrypoints";

/**
 * Open an entry point in its app tab, or focus the tab it already has. Each entry point has one
 * tab per workspace (its view key names server, tool and type), so a second open only focuses
 * it and never calls the tool again, unless the result store evicted the tab's record: then
 * the tab would show no result, so the entry point runs again. A `thread` entry point behaves
 * like a `global` one here: the spec gives each thread its own instance, and in Xum tabs
 * already belong to one workspace. Returns an error message, or null once shown.
 */
export async function openMcpAppEntrypoint(
  api: APIClient,
  workspaceId: string,
  entrypoint: McpAppEntrypoint,
  /** Where the tab goes; by default the focused pane (OPEN_MCP_APP_VIEW). */
  show: (view: McpAppViewRef) => void = (view) => focusMcpAppViewTab(workspaceId, view.toolCallId)
): Promise<string | null> {
  try {
    if (await hasStoredTab(api, workspaceId, entrypoint.viewKey)) {
      show(entrypointViewRef(workspaceId, entrypoint));
      return null;
    }
    const result = await api.mcpApps.openEntrypoint({
      workspaceId,
      serverName: entrypoint.serverName,
      toolName: entrypoint.toolName,
      type: entrypoint.type,
    });
    if (!result.success) return result.error;
    // The backend's answer, not the listed entry point: its view (resourceUri) can have moved.
    show(openedMcpAppEntrypoint(workspaceId, result.data));
    return null;
  } catch (error) {
    return getErrorMessage(error);
  }
}

/** Whether the workspace has a tab for the view and the result store still has its record. */
async function hasStoredTab(api: APIClient, workspaceId: string, viewKey: string) {
  const layout = parseRightSidebarLayoutState(
    readPersistedState<unknown>(getRightSidebarLayoutKey(workspaceId), null)
  );
  if (!collectAllTabs(layout.root).includes(appViewTabFor(viewKey))) return false;
  const records = await api.mcpApps.getViewRecords({ workspaceId, toolCallIds: [viewKey] });
  // A failed lookup counts as stored: run the tool again only when the record is known gone.
  return !records.success || records.data.some((entry) => entry.view !== null);
}
