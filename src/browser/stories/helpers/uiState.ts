import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import {
  SELECTED_WORKSPACE_KEY,
  EXPANDED_PROJECTS_KEY,
  LEFT_SIDEBAR_COLLAPSED_KEY,
  getRightSidebarCollapsedKey,
  getInputKey,
} from "@/common/constants/storage";

// ═══════════════════════════════════════════════════════════════════════════════
// WORKSPACE SELECTION
// ═══════════════════════════════════════════════════════════════════════════════

/** Set localStorage to select a workspace */
export function selectWorkspace(workspace: FrontendWorkspaceMetadata): void {
  localStorage.setItem(SELECTED_WORKSPACE_KEY, JSON.stringify({ workspaceId: workspace.id }));
}

/** Clear workspace selection from localStorage (for sidebar-focused stories) */
export function clearWorkspaceSelection(): void {
  localStorage.removeItem(SELECTED_WORKSPACE_KEY);
}

/** Set input text for a workspace */
export function setWorkspaceInput(workspaceId: string, text: string): void {
  localStorage.setItem(getInputKey(workspaceId), JSON.stringify(text));
}

/** Expand projects in the sidebar */
export function expandProjects(projectPaths: string[]): void {
  localStorage.setItem(EXPANDED_PROJECTS_KEY, JSON.stringify(projectPaths));
}

/**
 * Collapse the right sidebar in every workspace (default for most stories). The flag is per
 * workspace and a workspace without one starts collapsed, so clearing them all collapses each.
 */
export function collapseRightSidebar(): void {
  const prefix = getRightSidebarCollapsedKey("");
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith(prefix)) localStorage.removeItem(key);
  }
}

/** Collapse the left sidebar (project tree) — use for stories that don't test the sidebar. */
export function collapseLeftSidebar(): void {
  localStorage.setItem(LEFT_SIDEBAR_COLLAPSED_KEY, JSON.stringify(true));
}

/** Expand the right sidebar of one workspace (for stories testing it) */
export function expandRightSidebar(workspaceId: string): void {
  localStorage.setItem(getRightSidebarCollapsedKey(workspaceId), JSON.stringify(false));
}

/**
 * Expand the wide (inline) left sidebar. The app defaults it to collapsed when it starts at
 * phone widths, where (Pixel's phone and tablet variants) the sidebar is a drawer that ignores
 * this saved state and starts closed: plays that click sidebar controls there open it with
 * `openLeftSidebar()` from `storyPlayHelpers.ts`.
 */
export function expandLeftSidebar(): void {
  updatePersistedState(LEFT_SIDEBAR_COLLAPSED_KEY, false);
}
