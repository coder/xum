import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { getAppViewTabKey, makeAppViewTabType, type TabType } from "@/browser/types/rightSidebar";
import {
  collectAllTabs,
  parseRightSidebarLayoutState,
  selectOrAddTab,
  type RightSidebarLayoutState,
} from "@/browser/utils/rightSidebarLayout";
import { getRightSidebarLayoutKey } from "@/common/constants/storage";
import {
  mcpAppSelectionKey,
  toolCallIdFromMcpAppKey,
  useMcpAppViewHostedBy,
  type McpAppViewHost,
} from "../ArtifactsTab/mcpAppViewsStore";

/**
 * MCP App views as right-sidebar tabs (artifacts experiment): one "app:<viewKey>" tab per view,
 * keyed by the view's mcpAppSelectionKey. Plugin UIs get their own tab like built-in tools,
 * instead of living in Artifacts (which shows only files the agent created).
 */

export function appViewTabFor(toolCallId: string): TabType {
  return makeAppViewTabType(mcpAppSelectionKey(toolCallId));
}

/** The tool call an app tab shows, or null for other (or malformed) tabs. */
export function appViewTabToolCallId(tab: TabType): string | null {
  const key = getAppViewTabKey(tab);
  return key == null ? null : toolCallIdFromMcpAppKey(key);
}

/** Open a view's tab, or focus the one it already has: a view never gets two tabs. */
export function withAppViewTab(
  state: RightSidebarLayoutState,
  toolCallId: string
): RightSidebarLayoutState {
  return selectOrAddTab(state, appViewTabFor(toolCallId));
}

/**
 * Whether the view lives elsewhere: an app tab is open for it in the workspace's layout
 * (mounted or not), or one of `hosts` has it mounted. A place that would show the view shows a
 * placeholder instead, so at most one live instance runs.
 */
export function useMcpAppViewInTab(
  workspaceId: string,
  toolCallId: string,
  hosts: readonly McpAppViewHost[]
): boolean {
  const [rawLayout] = usePersistedState<unknown>(getRightSidebarLayoutKey(workspaceId), null, {
    listener: true,
  });
  const hosted = useMcpAppViewHostedBy(workspaceId, toolCallId, hosts);
  const tab = appViewTabFor(toolCallId);
  return (
    hosted ||
    (rawLayout != null &&
      collectAllTabs(parseRightSidebarLayoutState(rawLayout).root).includes(tab))
  );
}

/** At most this many app tabs per tabset stay mounted while hidden (see RightSidebar). */
export const MAX_LIVE_APP_VIEW_TABS = 3;

/**
 * The stored activation order after `active` became the active tab: newest first, only tabs
 * still in the tabset, at most MAX_LIVE_APP_VIEW_TABS. Bounded, because a long-lived tabset
 * opens and closes many views and only the newest few can stay mounted anyway.
 */
export function nextRecentAppViewTabs(
  recent: readonly TabType[],
  active: TabType,
  tabs: readonly TabType[]
): TabType[] {
  return [active, ...recent.filter((tab) => tab !== active && tabs.includes(tab))].slice(
    0,
    MAX_LIVE_APP_VIEW_TABS
  );
}

/**
 * The app tabs of a tabset that stay mounted: the most recently active ones, newest first.
 * `recent` is the tabset's activation order; tabs no longer in the tabset drop out.
 */
export function liveAppViewTabs(recent: readonly TabType[], tabs: readonly TabType[]): TabType[] {
  return recent.filter((tab) => tabs.includes(tab)).slice(0, MAX_LIVE_APP_VIEW_TABS);
}
