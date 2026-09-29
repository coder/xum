import type { ConfirmDialogOptions } from "@/browser/contexts/ConfirmDialogContext";

/**
 * The confirmation a user-initiated workspace removal shows. Shared by the command palette and
 * the interrupted-delegated-setup banner (#4983), so both ask the same question before the same
 * non-forced removal.
 */
export function removeWorkspaceConfirmOptions(
  title: string,
  branchName: string
): ConfirmDialogOptions {
  return {
    title,
    description: `This will delete the worktree and local branch "${branchName}".`,
    warning: "This cannot be undone.",
    confirmLabel: "Remove",
    confirmVariant: "destructive",
  };
}
