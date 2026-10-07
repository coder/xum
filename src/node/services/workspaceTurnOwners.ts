import * as path from "node:path";
import type { ProjectsConfig, Workspace as WorkspaceConfigEntry } from "@/node/config";
import { WORKSPACE_TURN_TASK_TAGS } from "@/constants/workspaceTags";

/**
 * Which owner directories can hold a target's workspace-turn records (#5569).
 *
 * Without it, the active-turn lookup scans every owner's task-handle directory on a map miss.
 * Records are stored under their owner, and createWorkspaceTurn's owner rule limits the owners:
 *
 * - ROOT target (no `parentWorkspaceId`): only the owner holding the target's creating
 *   (`createdWorkspace`) record, so every record lives in its creator's directory. This module
 *   names the claimed creator: the creator's own `delegatedCreation` mark, else the
 *   `mux.taskOwnerWorkspaceId` tag (the startup resolver's precedence). Tags are caller-editable,
 *   so the claim is only a hint: the caller must confirm it by finding the creating record in that
 *   same owner's listing. An unconfirmed claim (wrong tag, creation in flight) falls back.
 * - AGENT-TASK target: only its ancestors (isDescendantAgentTaskInConfig on the reawaken path). No
 *   code rewrites `parentWorkspaceId`, so the config ancestors now are those at admission. This
 *   assumes only `mode: "new"` writes creating records, and it creates roots only. A missing or
 *   duplicated row on the chain, or more than MAX_ANCESTOR_LEVELS levels (a cycle), falls back.
 *
 * Non-guarantee: the narrowed lookup relies only on the owner rule. A record that breaks it (for
 * example one for an agent task owned by a non-ancestor) is missed, while the global scan returns
 * it. So is a record under a symlinked `sessions/<owner>`, which the global scan skips. Only
 * fixtures or hand edits create these states. Changing the owner rule must update this module.
 */
export type WorkspaceTurnOwners =
  | { kind: "creator"; ownerWorkspaceId: string }
  | { kind: "ancestors"; ownerWorkspaceIds: string[] }
  | { kind: "fallback"; reason: string };

// Admission walks at most 32 levels (isDescendantAgentTaskUsingParentById), so 64 covers it.
const MAX_ANCESTOR_LEVELS = 64;

// An owner ID becomes a sessions/<owner> path segment; refuse anything that could leave it.
const isPathSegment = (id: string) =>
  id.trim() !== "" && path.basename(id) === id && id !== "." && id !== ".." && !id.includes("\0");

export function resolveWorkspaceTurnOwners(
  config: ProjectsConfig,
  workspaceId: string
): WorkspaceTurnOwners {
  // Every row by ID, a duplicated ID as null: findWorkspaceEntry returns the first match and would
  // hide a duplicate.
  const rowsById = new Map<string, WorkspaceConfigEntry | null>();
  for (const project of config.projects.values()) {
    for (const row of project.workspaces) {
      if (row.id != null) rowsById.set(row.id, rowsById.has(row.id) ? null : row);
    }
  }
  const row = rowsById.get(workspaceId);
  if (row == null) return { kind: "fallback", reason: row === null ? "duplicate row" : "no row" };
  if (row.parentWorkspaceId != null) {
    const ownerWorkspaceIds: string[] = [];
    for (let current = row; current.parentWorkspaceId != null; ) {
      const parentId = current.parentWorkspaceId;
      if (ownerWorkspaceIds.length === MAX_ANCESTOR_LEVELS) {
        return { kind: "fallback", reason: `more than ${MAX_ANCESTOR_LEVELS} ancestor levels` };
      }
      const parent = rowsById.get(parentId);
      if (parent == null || !isPathSegment(parentId)) {
        return {
          kind: "fallback",
          reason: `ancestor ${parentId}: missing, duplicate or unsafe row`,
        };
      }
      ownerWorkspaceIds.push(parentId);
      current = parent;
    }
    return { kind: "ancestors", ownerWorkspaceIds };
  }

  // Config loading keeps tag values as written, so a hand-edited tag can be a non-string.
  const claim: unknown =
    row.delegatedCreation?.ownerWorkspaceId ??
    row.tags?.[WORKSPACE_TURN_TASK_TAGS.ownerWorkspaceId];
  if (typeof claim !== "string" || claim.trim() === "") {
    return { kind: "fallback", reason: "no creator claim" };
  }
  if (!isPathSegment(claim)) {
    return { kind: "fallback", reason: "creator claim is not a path segment" };
  }
  return { kind: "creator", ownerWorkspaceId: claim };
}
