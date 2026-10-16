import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";

/**
 * Open (and focus) the right sidebar's Plan tab for a workspace. RightSidebar adds or selects
 * the tab and un-collapses the sidebar; on a narrow layout, where the sidebar is hidden,
 * WorkspaceMenuBar shows the tab full-screen instead.
 */
export function openPlanTab(workspaceId: string): void {
  window.dispatchEvent(createCustomEvent(CUSTOM_EVENTS.OPEN_PLAN_TAB, { workspaceId }));
}
