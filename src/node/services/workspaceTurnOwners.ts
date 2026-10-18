import * as path from "node:path";
import type { ProjectsConfig, Workspace as WorkspaceConfigEntry } from "@/node/config";
import { WORKSPACE_TURN_TASK_TAGS } from "@/constants/workspaceTags";

/**
 * Which owner directory can hold a target's workspace-turn records (#5569).
 *
 * Without it, the active-turn lookup scans every owner's task-handle directory on a map miss. For a
 * ROOT target (no `parentWorkspaceId`) createWorkspaceTurn's owner rule allows a record only for
 * the owner holding the target's creating (`createdWorkspace`) record, so every record of that
 * root lives in its creator's directory. This module names the claimed creator: the creator's own
 * `delegatedCreation` mark, else the `mux.taskOwnerWorkspaceId` tag (the startup resolver's
 * precedence). Tags are caller-editable, so the claim is only a hint: the caller must confirm it by
 * finding the creating record in that same owner's listing before answering from that directory.
 * An unconfirmed claim (wrong tag, creation still in flight) falls back to the global scan.
 *
 * Non-guarantee: the narrowed lookup relies only on the owner rule. A record that breaks it (for
 * example a running record for a claimed root owned by someone other than its creator) is missed,
 * while the global scan returns it. Only fixtures or hand edits create such records. Changing the
 * owner rule in createWorkspaceTurn must update this module. A symlinked `sessions/<owner>` is
 * missed the same way: the global scan skips it, the owner listing follows it.
 *
 * An AGENT-TASK target (a row with `parentWorkspaceId`) admits only its ancestors (the reawaken
 * path's isDescendantAgentTaskInConfig), so its records live in its config ancestors' directories.
 * No code rewrites `parentWorkspaceId`, so the ancestors now are the ancestors at admission. This
 * assumes only `mode: "new"` writes creating records and creates roots only. A missing or
 * duplicated row on the chain, or more than MAX_ANCESTOR_LEVELS levels (a cycle), falls back.
 *
 * A ROOT stamped `bornWithoutDelegation` (the public create wrote it in the row's birth write)
 * has no owner at all: only `mode: "new"` writes a creating record, and only for a row it created
 * with a `delegatedCreation` mark, so no turn can target it ("none", no file read). The stamp
 * counts only on the single config row of its ID, and never beside a mark. Config load already
 * drops it otherwise (normalizeBirthStamp); the check here keeps that rule local.
 */
export type WorkspaceTurnOwners =
  | { kind: "creator"; ownerWorkspaceId: string }
  | { kind: "ancestors"; ownerWorkspaceIds: string[] }
  | { kind: "none" }
  | { kind: "fallback"; reason: string };

// Admission walks at most 32 levels (isDescendantAgentTaskUsingParentById), so 64 covers it.
const MAX_ANCESTOR_LEVELS = 64;

export function resolveWorkspaceTurnOwners(
  config: ProjectsConfig,
  workspaceId: string
): WorkspaceTurnOwners {
  // Scan every row: findWorkspaceEntry returns the first match and would hide a duplicate ID.
  const rows = [...config.projects.values()].flatMap((project) =>
    project.workspaces.filter((workspace) => workspace.id === workspaceId)
  );
  if (rows.length !== 1) return { kind: "fallback", reason: `${rows.length} config rows` };
  const row = rows[0];
  return row.parentWorkspaceId != null ? resolveAncestors(config, row) : resolveRoot(row);
}

// A root: no owner when stamped at birth, else its claimed creator.
function resolveRoot(row: WorkspaceConfigEntry): WorkspaceTurnOwners {
  if (row.bornWithoutDelegation === true && row.delegatedCreation == null) return { kind: "none" };

  // Config loading keeps tag values as written, so a hand-edited tag can be a non-string.
  const claim: unknown =
    row.delegatedCreation?.ownerWorkspaceId ??
    row.tags?.[WORKSPACE_TURN_TASK_TAGS.ownerWorkspaceId];
  if (typeof claim !== "string") return { kind: "fallback", reason: "no creator claim" };
  if (!isPathSegment(claim)) {
    return { kind: "fallback", reason: "creator claim is empty or not a path segment" };
  }
  return { kind: "creator", ownerWorkspaceId: claim };
}

// An owner ID becomes a sessions/<owner> path segment; refuse anything that could leave it.
function isPathSegment(id: string): boolean {
  return (
    id.trim() !== "" && path.basename(id) === id && id !== "." && id !== ".." && !id.includes("\0")
  );
}

// Only agent tasks build the row map; root targets keep the single filter above (#5569).
function resolveAncestors(config: ProjectsConfig, row: WorkspaceConfigEntry): WorkspaceTurnOwners {
  // Every row by ID, a duplicated ID as null, so a duplicate ancestor cannot hide behind the first.
  const rowsById = new Map<string, WorkspaceConfigEntry | null>();
  for (const project of config.projects.values()) {
    for (const entry of project.workspaces) {
      if (entry.id != null) rowsById.set(entry.id, rowsById.has(entry.id) ? null : entry);
    }
  }
  const ownerWorkspaceIds: string[] = [];
  for (let current = row; current.parentWorkspaceId != null; ) {
    const parentId = current.parentWorkspaceId;
    if (ownerWorkspaceIds.length === MAX_ANCESTOR_LEVELS) {
      return { kind: "fallback", reason: `more than ${MAX_ANCESTOR_LEVELS} ancestor levels` };
    }
    const parent = rowsById.get(parentId);
    // The ID becomes a sessions/<owner> path segment, as a creator claim does.
    if (parent == null || !isPathSegment(parentId)) {
      return { kind: "fallback", reason: `ancestor ${parentId}: missing, duplicate or unsafe row` };
    }
    ownerWorkspaceIds.push(parentId);
    current = parent;
  }
  return { kind: "ancestors", ownerWorkspaceIds };
}
