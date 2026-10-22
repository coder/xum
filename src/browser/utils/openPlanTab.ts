import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";

/**
 * Open the right sidebar's Plan tab for a workspace. RightSidebar adds or selects the tab and
 * un-collapses the sidebar; on a narrow layout, where the sidebar is hidden, WorkspaceMenuBar
 * shows the tab full-screen as well. With `focus`, the panel takes focus once it renders, so
 * its single-key shortcuts work for a keyboard user whose control went away with the tab
 * switch (the Stats tab's Plan file row); "/plan open" leaves focus in the chat input.
 */
export function openPlanTab(workspaceId: string, options?: { focus?: boolean }): void {
  window.dispatchEvent(
    createCustomEvent(CUSTOM_EVENTS.OPEN_PLAN_TAB, { workspaceId, focus: options?.focus === true })
  );
}
