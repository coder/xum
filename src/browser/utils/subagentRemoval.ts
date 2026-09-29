import type { APIClient } from "@/browser/contexts/API";
import type { ConfirmDialogOptions } from "@/browser/contexts/ConfirmDialogContext";
import type { WorkspaceRemoveResult } from "@/common/types/workspace";

/**
 * #5106: user-confirmed removal of one sub-agent. The confirmation lists what removal would
 * permanently delete (the same work a model's task_remove refusal reports), and the sub-agent is
 * force-removed only after the user confirms. Returns an error to show, or null when the
 * sub-agent was removed or the user cancelled.
 */
export async function confirmAndRemoveSubagent(params: {
  api: APIClient | null;
  confirm: (options: ConfirmDialogOptions) => Promise<boolean>;
  removeSubagent: (workspaceId: string) => Promise<WorkspaceRemoveResult>;
  workspaceId: string;
  title: string;
}): Promise<string | null> {
  if (params.api == null) return "API not connected";
  const preview = await params.api.tasks.previewRemoval({ taskId: params.workspaceId });
  if (!preview.success) return preview.error;
  const confirmed = await params.confirm({
    title: `Remove sub-agent "${params.title}"?`,
    description: preview.data.summary ?? "No unsaved work was found in its checkout.",
    details: { label: "Uncommitted or untracked files", items: preview.data.paths },
    warning: "This cannot be undone.",
    confirmLabel: "Remove sub-agent",
    confirmVariant: "destructive",
  });
  if (!confirmed) return null;
  const result = await params.removeSubagent(params.workspaceId);
  return result.success ? null : (result.error ?? "Failed to remove the sub-agent");
}
