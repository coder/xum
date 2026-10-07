import * as path from "node:path";
import type { ProjectsConfig } from "@/node/config";
import { WORKSPACE_TURN_TASK_TAGS } from "@/constants/workspaceTags";

/**
 * Which owner directory can hold a target's workspace-turn records (#5569).
 *
 * The active-turn lookup used to scan every owner's task-handle directory on each map miss. For a
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
 * owner rule in createWorkspaceTurn must update this module.
 *
 * Agent tasks (rows with `parentWorkspaceId`) can hold records from several ancestors, so they
 * fall back for now.
 */
export type WorkspaceTurnOwners =
  | { kind: "creator"; ownerWorkspaceId: string }
  | { kind: "fallback"; reason: string };

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
  if (row.parentWorkspaceId != null) return { kind: "fallback", reason: "agent task" };

  const claim =
    row.delegatedCreation?.ownerWorkspaceId ??
    row.tags?.[WORKSPACE_TURN_TASK_TAGS.ownerWorkspaceId] ??
    "";
  if (claim.trim() === "") return { kind: "fallback", reason: "no creator claim" };
  // The claim becomes a sessions/<owner> path segment; refuse anything that could leave it.
  if (path.basename(claim) !== claim || claim === "." || claim === ".." || claim.includes("\0")) {
    return { kind: "fallback", reason: "creator claim is not a path segment" };
  }
  return { kind: "creator", ownerWorkspaceId: claim };
}
