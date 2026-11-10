import { isWorktreeRuntime } from "@/common/types/runtime";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";

export interface ArchivedHistoryRows {
  /** Workspaces listed as their own rows in the Archived Workspaces history. */
  rows: FrontendWorkspaceMetadata[];
  /**
   * Sub-agents folded into a listed row, keyed by that row's id (all descendants, not only direct
   * children). Bulk delete removes them with the row and its cost includes theirs.
   */
  foldedByRowId: Map<string, FrontendWorkspaceMetadata[]>;
}

/** Top of a workspace's archived ancestry: itself when its parent is not archived; null on a cycle. */
function getArchivedTop(
  workspace: FrontendWorkspaceMetadata,
  archivedById: ReadonlyMap<string, FrontendWorkspaceMetadata>
): FrontendWorkspaceMetadata | null {
  const visited = new Set<string>([workspace.id]);
  let current = workspace;
  for (;;) {
    const parentId = current.parentWorkspaceId;
    const parent = parentId == null ? undefined : archivedById.get(parentId);
    if (parent == null) return current;
    if (visited.has(parent.id)) return null;
    visited.add(parent.id);
    current = parent;
  }
}

function isWorkerOfLiveParent(
  workspace: FrontendWorkspaceMetadata,
  liveWorkspaceIds: { has(id: string): boolean } | undefined
): boolean {
  const parentId = workspace.parentWorkspaceId;
  return (
    workspace.workflowTask != null && parentId != null && liveWorkspaceIds?.has(parentId) === true
  );
}

/**
 * The archived history should list what the user archived, not every sub-agent swept along with
 * it: archiving a parent cascades over its sub-agents (#4477) and the startup sweep archives the
 * leftover workers of ended workflow runs, so each archive could otherwise add dozens of agent
 * rows. Two kinds of sub-agent are folded away:
 *
 * - one whose archived ancestry reaches a listed row: that row stands for the whole subtree;
 * - a workflow worker (and its subtree) whose parent is still live: workflow workers are never
 *   managed individually, and archiving or removing the parent covers them.
 *
 * Every other sub-agent stays listed: orphans, and user-owned sub-agents left archived after
 * their parent was restored (the user restores those one by one). A parent cycle in corrupted
 * metadata lists its members instead of hiding them all.
 */
export function partitionArchivedHistoryRows(
  workspaces: readonly FrontendWorkspaceMetadata[],
  /** Unarchived workspace ids; absent outside WorkspaceProvider, where no parent counts as live. */
  liveWorkspaceIds: { has(id: string): boolean } | undefined
): ArchivedHistoryRows {
  const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace] as const));
  const rows: FrontendWorkspaceMetadata[] = [];
  const foldedByRowId = new Map<string, FrontendWorkspaceMetadata[]>();
  for (const workspace of workspaces) {
    const top = getArchivedTop(workspace, byId) ?? workspace;
    // A worker of a live parent hides with everything below it; nothing lists it.
    if (isWorkerOfLiveParent(top, liveWorkspaceIds)) continue;
    if (top === workspace) {
      rows.push(workspace);
      continue;
    }
    const folded = foldedByRowId.get(top.id) ?? [];
    folded.push(workspace);
    foldedByRowId.set(top.id, folded);
  }
  return { rows, foldedByRowId };
}

/** Sum of the known costs; undefined while none is known, so a missing cost never reads as $0. */
export function sumKnownCosts(costs: Iterable<number | undefined>): number | undefined {
  let sum: number | undefined;
  for (const cost of costs) {
    if (cost !== undefined) sum = (sum ?? 0) + cost;
  }
  return sum;
}

/** A row's cost includes the sub-agents folded into it, so totals keep their spend. */
export function getHistoryRowCost(
  rowId: string,
  foldedByRowId: ReadonlyMap<string, readonly FrontendWorkspaceMetadata[]>,
  costsById: Readonly<Record<string, number | undefined>>
): number | undefined {
  const folded = foldedByRowId.get(rowId) ?? [];
  return sumKnownCosts(
    [rowId, ...folded.map((workspace) => workspace.id)].map((id) => costsById[id])
  );
}

/**
 * Selected rows plus the sub-agents folded into them. Deleting a row deletes those too: the backend
 * refuses to remove a parent before its descendants, and folded rows cannot be selected themselves.
 */
export function expandHistorySelection(
  selectedIds: Iterable<string>,
  foldedByRowId: ReadonlyMap<string, readonly FrontendWorkspaceMetadata[]>
): string[] {
  const ids = new Set<string>();
  for (const id of selectedIds) {
    ids.add(id);
    for (const folded of foldedByRowId.get(id) ?? []) ids.add(folded.id);
  }
  return Array.from(ids);
}

/** The selection limited to listed rows, so a row that folded away is never acted on unseen. */
export function keepListedSelection(
  selectedIds: ReadonlySet<string>,
  rows: readonly FrontendWorkspaceMetadata[]
): Set<string> {
  return new Set(rows.filter((row) => selectedIds.has(row.id)).map((row) => row.id));
}

export function canDeleteManagedWorktree(workspace: FrontendWorkspaceMetadata): boolean {
  return (
    isWorktreeRuntime(workspace.runtimeConfig) &&
    workspace.transcriptOnly !== true &&
    // isolation:none tasks reuse an ancestor checkout, so they do not own local worktree state.
    workspace.taskIsolation !== "none"
  );
}

/** The ids, in order, whose workspace owns a managed local checkout. */
export function getCheckoutOwnerIds(
  ids: readonly string[],
  workspaces: readonly FrontendWorkspaceMetadata[]
): string[] {
  const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace] as const));
  return ids.filter((id) => {
    const workspace = byId.get(id);
    return workspace != null && canDeleteManagedWorktree(workspace);
  });
}
