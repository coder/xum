/**
 * DOM-based workspace navigation utilities.
 *
 * Reads the rendered sidebar to determine workspace ordering. This is the
 * canonical source of truth for visual workspace navigation because it reflects
 * the exact order the user sees (respecting sort, sections, collapsed
 * projects, etc.).
 *
 * Shared by Ctrl+J/K navigation and archive-then-navigate behaviour.
 */

/** Compound selector that targets only workspace *row* elements. */
const WORKSPACE_ROW_SELECTOR = "[data-workspace-id][data-workspace-path]";

export interface FindAdjacentWorkspaceIdOptions {
  /** Project to keep the selection in when a sibling chat exists there. */
  preferredProjectPath: string;
  /** Resolve a visible workspace row to its project path. */
  getProjectPath: (workspaceId: string) => string | undefined;
}

/** Return all visible workspace IDs in DOM (sidebar) order. */
export function getVisibleWorkspaceIds(): string[] {
  const els = document.querySelectorAll(WORKSPACE_ROW_SELECTOR);
  return Array.from(els).map((el) => el.getAttribute("data-workspace-id")!);
}

/**
 * Given a workspace that is about to be removed (archived / deleted), return
 * the ID of the workspace the user should land on next.
 *
 * User rationale: archiving a chat should stay in the same project when
 * possible so removing one row does not unexpectedly jump to another project.
 * Selection priority: same-project row above, same-project row below, any row
 * above, any row below, otherwise null.
 *
 * When the current workspace is not rendered at all (e.g. its project or
 * section is collapsed), every other visible row counts as "below" so the same
 * preference chain applies.
 */
export function findAdjacentWorkspaceId(
  currentWorkspaceId: string,
  options: FindAdjacentWorkspaceIdOptions
): string | null {
  const ids = getVisibleWorkspaceIds();
  const idx = ids.indexOf(currentWorkspaceId);

  // Nearest-first on both sides: walk upward from the removed row, then downward.
  const above = idx === -1 ? [] : ids.slice(0, idx).reverse();
  const below = idx === -1 ? ids.filter((id) => id !== currentWorkspaceId) : ids.slice(idx + 1);

  const inPreferredProject = (id: string) =>
    options.getProjectPath(id) === options.preferredProjectPath;

  return (
    above.find(inPreferredProject) ?? below.find(inPreferredProject) ?? above[0] ?? below[0] ?? null
  );
}
