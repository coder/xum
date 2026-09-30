export const WORKTREE_ARCHIVE_BEHAVIORS = ["keep", "delete", "snapshot"] as const;

export type WorktreeArchiveBehavior = (typeof WORKTREE_ARCHIVE_BEHAVIORS)[number];

export const DEFAULT_WORKTREE_ARCHIVE_BEHAVIOR: WorktreeArchiveBehavior = "keep";

export function isWorktreeArchiveBehavior(value: unknown): value is WorktreeArchiveBehavior {
  return (
    typeof value === "string" &&
    WORKTREE_ARCHIVE_BEHAVIORS.includes(value as WorktreeArchiveBehavior)
  );
}

export function shouldDeleteWorktreeOnArchive(
  behavior: WorktreeArchiveBehavior | undefined
): boolean {
  return behavior === "delete" || behavior === "snapshot";
}
