import type { APIClient } from "@/browser/contexts/API";
import { readPersistedState } from "@/browser/hooks/usePersistedState";
import { collectAllTabs, parseRightSidebarLayoutState } from "@/browser/utils/rightSidebarLayout";
import { getRightSidebarLayoutKey } from "@/common/constants/storage";
import type { McpAppEntrypoint } from "@/common/orpc/schemas/mcpApps";
import { getErrorMessage } from "@/common/utils/errors";
import { openMcpAppViewTab, type McpAppViewRef } from "../ArtifactsTab/mcpAppViewsStore";
import { appViewTabFor } from "./appViewTabs";
import { entrypointViewRef } from "./mcpAppEntrypoints";

/**
 * Open an entry point in its app tab, or focus the tab it already has. Each entry point has one
 * tab per workspace (its view key names server, tool and type), so a second open only focuses
 * it and never calls the tool again. A `thread` entry point behaves like a `global` one here:
 * the spec gives each thread its own instance, and in Xum tabs already belong to one workspace.
 * Returns an error message, or null once shown.
 */
export async function openMcpAppEntrypoint(
  api: APIClient,
  workspaceId: string,
  entrypoint: McpAppEntrypoint,
  /** Where the tab goes; by default the focused pane (OPEN_MCP_APP_VIEW). */
  show: (view: McpAppViewRef) => void = (view) => openMcpAppViewTab(workspaceId, view)
): Promise<string | null> {
  const view = entrypointViewRef(entrypoint);
  const layout = parseRightSidebarLayoutState(
    readPersistedState<unknown>(getRightSidebarLayoutKey(workspaceId), null)
  );
  if (!collectAllTabs(layout.root).includes(appViewTabFor(view.toolCallId))) {
    try {
      const result = await api.mcpApps.openEntrypoint({
        workspaceId,
        serverName: entrypoint.serverName,
        toolName: entrypoint.toolName,
        type: entrypoint.type,
      });
      if (!result.success) return result.error;
    } catch (error) {
      return getErrorMessage(error);
    }
  }
  show(view);
  return null;
}
