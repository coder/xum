import type { APIClient } from "@/browser/contexts/API";
import { readPersistedState } from "@/browser/hooks/usePersistedState";
import { collectAllTabs, parseRightSidebarLayoutState } from "@/browser/utils/rightSidebarLayout";
import { getRightSidebarLayoutKey } from "@/common/constants/storage";
import type { McpAppEntrypoint } from "@/common/orpc/schemas/mcpApps";
import type { TabType } from "@/browser/types/rightSidebar";
import { getErrorMessage } from "@/common/utils/errors";
import {
  focusMcpAppViewTab,
  reloadMcpAppView,
  type McpAppViewRef,
} from "../ArtifactsTab/mcpAppViewsStore";
import { appViewTabFor, saveAppViewTab } from "./appViewTabs";
import { entrypointViewRef, openedMcpAppEntrypoint } from "./mcpAppEntrypoints";

/** What an entry point open reports without a backend connection (launcher and palette). */
export const MCP_APP_ENTRYPOINT_NOT_CONNECTED = "Not connected";

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
  show: (view: McpAppViewRef) => void = (view) => showInWorkspace(workspaceId, view.toolCallId)
): Promise<string | null> {
  const resolved = await resolveEntrypointView(api, workspaceId, entrypoint);
  if (typeof resolved === "string") return resolved;
  show(resolved);
  return null;
}

/**
 * The palette's open: the tab goes into the workspace's saved layout first, since the user can
 * switch workspace while the open runs and then no sidebar of this workspace listens for
 * OPEN_MCP_APP_VIEW. The next pick then finds the tab instead of running the tool again. The
 * event focuses the tab only where the workspace's sidebar is mounted.
 */
function showInWorkspace(workspaceId: string, toolCallId: string) {
  saveAppViewTab(workspaceId, toolCallId);
  focusMcpAppViewTab(workspaceId, toolCallId);
}

/**
 * Opens in flight, by workspace and view key. The tab is added only once an open returns, so
 * two opens of one entry point (two split-pane launchers, or the palette while a launcher open
 * runs) would both find no tab and call the tool twice, racing on one view record. A second
 * open joins the first instead; each caller still decides itself whether to show the result.
 */
const inFlightOpens = new Map<string, Promise<McpAppViewRef | string>>();

function resolveEntrypointView(
  api: APIClient,
  workspaceId: string,
  entrypoint: McpAppEntrypoint
): Promise<McpAppViewRef | string> {
  const key = `${workspaceId}\u0000${entrypoint.viewKey}`;
  const joined = inFlightOpens.get(key);
  if (joined !== undefined) return joined;
  const open = resolveEntrypointViewOnce(api, workspaceId, entrypoint).finally(() => {
    inFlightOpens.delete(key);
  });
  inFlightOpens.set(key, open);
  return open;
}

/** The view to show, or an error message. */
async function resolveEntrypointViewOnce(
  api: APIClient,
  workspaceId: string,
  entrypoint: McpAppEntrypoint
): Promise<McpAppViewRef | string> {
  try {
    if (await hasCurrentTab(api, workspaceId, entrypoint)) {
      return entrypointViewRef(workspaceId, entrypoint);
    }
    const result = await api.mcpApps.openEntrypoint({
      workspaceId,
      serverName: entrypoint.serverName,
      toolName: entrypoint.toolName,
      type: entrypoint.type,
    });
    if (!result.success) return result.error;
    // A tab already open for it keeps its earlier load (an evicted record, a moved view):
    // remount its frame, so it shows the new record.
    reloadMcpAppView(workspaceId, result.data.viewKey);
    // The backend's answer, not the listed entry point: its view (resourceUri) can have moved.
    return openedMcpAppEntrypoint(workspaceId, result.data);
  } catch (error) {
    return getErrorMessage(error);
  }
}

/**
 * The New tab launcher's open: the app tab replaces that pane's New tab. The open can outlive
 * the launcher's choice: the user may pick another row, or close the pane, while it runs. Then
 * its completion is dropped instead of overriding the newer choice (the view record stays, so a
 * later pick reuses it).
 */
export function openMcpAppEntrypointInNewTab(
  api: APIClient | null,
  workspaceId: string,
  entrypoint: McpAppEntrypoint,
  isCurrent: () => boolean,
  replaceNewTab: (tab: TabType) => void
): Promise<string | null> {
  if (api == null) return Promise.resolve(MCP_APP_ENTRYPOINT_NOT_CONNECTED);
  return openMcpAppEntrypoint(api, workspaceId, entrypoint, (view) => {
    if (isCurrent()) replaceNewTab(appViewTabFor(view.toolCallId));
  });
}

/**
 * Whether the workspace has a tab for the entry point and the result store still has its record
 * for the entry point as it is now. A record naming another server or view (a plugin update moved
 * the resourceUri) would be refused by getView after a remount, so the entry point runs again.
 * Records carry the server's display form, which equals the key for every ordinary key; an
 * unusual key only makes a pick run the entry point again.
 */
async function hasCurrentTab(api: APIClient, workspaceId: string, entrypoint: McpAppEntrypoint) {
  const layout = parseRightSidebarLayoutState(
    readPersistedState<unknown>(getRightSidebarLayoutKey(workspaceId), null)
  );
  if (!collectAllTabs(layout.root).includes(appViewTabFor(entrypoint.viewKey))) return false;
  const records = await api.mcpApps.getViewRecords({
    workspaceId,
    toolCallIds: [entrypoint.viewKey],
  });
  // A failed lookup counts as current: run the tool again only when the record is known stale.
  return (
    !records.success ||
    records.data.some(
      (entry) =>
        entry.view?.serverName === entrypoint.serverName &&
        entry.view.resourceUri === entrypoint.resourceUri
    )
  );
}
