import {
  shouldDeleteWorktreeOnArchive,
  type WorktreeArchiveBehavior,
} from "@/common/config/worktreeArchiveBehavior";
import type { FrontendWorkspaceMetadata, WorkspaceMetadata } from "@/common/types/workspace";
import { Ok, type Result } from "@/common/types/result";
import { isWorktreeRuntime as isCommonWorktreeRuntime } from "@/common/types/runtime";
import type { AfterArchiveHook } from "@/node/services/workspaceLifecycleHooks";
import { log } from "@/node/services/log";
import { removeManagedGitWorktree } from "@/node/worktree/removeManagedGitWorktree";

function hasNamedWorkspacePath(
  workspaceMetadata: WorkspaceMetadata
): workspaceMetadata is FrontendWorkspaceMetadata {
  return typeof (workspaceMetadata as FrontendWorkspaceMetadata).namedWorkspacePath === "string";
}

export const isWorktreeRuntime = isCommonWorktreeRuntime;

/**
 * Whether archiving with this behavior deletes the workspace's managed worktree (the hook below).
 * Archive takes the cross-process mutation gate exactly when this holds (#4476).
 */
export function archiveDeletesManagedWorktree(
  workspaceMetadata: WorkspaceMetadata,
  behavior: WorktreeArchiveBehavior
): boolean {
  return (
    isWorktreeRuntime(workspaceMetadata.runtimeConfig) &&
    // isolation:none tasks point at an ancestor's checkout, so treating their path as a managed
    // child worktree would delete the parent's live workspace.
    workspaceMetadata.taskIsolation !== "none" &&
    shouldDeleteWorktreeOnArchive(behavior) &&
    // Snapshot archives skip the clean-up for multi-project workspaces.
    !(
      behavior === "snapshot" &&
      Array.isArray(workspaceMetadata.projects) &&
      workspaceMetadata.projects.length > 1
    )
  );
}

export function createWorktreeArchiveHook(options: {
  getWorktreeArchiveBehavior: () => WorktreeArchiveBehavior;
}): AfterArchiveHook {
  return async ({ workspaceMetadata, worktreeArchiveBehavior }): Promise<Result<void>> => {
    // Prefer the archive operation's behavior snapshot: deciding deletion on a fresh config
    // read would let a keep→delete settings flip mid-archive delete a checkout that was never
    // snapshotted (the snapshot decision was made with the earlier value).
    const behavior = worktreeArchiveBehavior ?? options.getWorktreeArchiveBehavior();
    if (!archiveDeletesManagedWorktree(workspaceMetadata, behavior)) {
      return Ok(undefined);
    }

    if (!hasNamedWorkspacePath(workspaceMetadata)) {
      log.debug(
        "Skipping managed worktree cleanup during archive because persisted path is missing",
        {
          workspaceId: workspaceMetadata.id,
        }
      );
      return Ok(undefined);
    }

    const managedPath = workspaceMetadata.namedWorkspacePath;

    try {
      // Use the persisted workspace path so archive cleanup also works for layouts like _workspaces.
      // Archive should stay non-blocking even if managed worktree cleanup fails.
      await removeManagedGitWorktree(workspaceMetadata.projectPath, managedPath);
    } catch (error) {
      log.debug("Failed to delete managed worktree during archive", {
        managedPath,
        error,
      });
    }

    return Ok(undefined);
  };
}
