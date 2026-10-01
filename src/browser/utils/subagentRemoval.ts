import type { APIClient } from "@/browser/contexts/API";
import type { ConfirmDialogOptions } from "@/browser/contexts/ConfirmDialogContext";
import type { WorkspaceRemoveResult } from "@/common/types/workspace";
import { getErrorMessage } from "@/common/utils/errors";
import { formatWorkspaceRemoveWarnings } from "@/browser/utils/workspace";

/** What to show after a sub-agent removal; null when it was removed cleanly or cancelled. */
export type SubagentRemovalNotice = { kind: "error" | "warning"; message: string } | null;

/**
 * #5106: user-confirmed removal of one sub-agent. The confirmation lists what removal would
 * permanently delete (the same work a model's task_remove refusal reports), and the sub-agent is
 * force-removed only after the user confirms. A successful removal that left something behind
 * returns a warning, not an error (#5190).
 */
export async function confirmAndRemoveSubagent(params: {
  api: APIClient | null;
  confirm: (options: ConfirmDialogOptions) => Promise<boolean>;
  removeSubagent: (
    workspaceId: string,
    acknowledgedWork: Parameters<APIClient["tasks"]["remove"]>[0]["acknowledgedWork"]
  ) => Promise<WorkspaceRemoveResult>;
  workspaceId: string;
  title: string;
}): Promise<SubagentRemovalNotice> {
  if (params.api == null) return { kind: "error", message: "API not connected" };
  // Palette actions run fire-and-forget, so a transport failure must come back as an error too.
  let preview: Awaited<ReturnType<APIClient["tasks"]["previewRemoval"]>>;
  try {
    preview = await params.api.tasks.previewRemoval({ taskId: params.workspaceId });
  } catch (error) {
    return { kind: "error", message: getErrorMessage(error) };
  }
  if (!preview.success) return { kind: "error", message: preview.error };
  const confirmed = await params.confirm({
    title: `Remove sub-agent "${params.title}"?`,
    description: preview.data.summary ?? "No unsaved work was found in its checkout.",
    details: { label: "Uncommitted or untracked files", items: preview.data.paths },
    warning: "This cannot be undone.",
    confirmLabel: "Remove sub-agent",
    confirmVariant: "destructive",
  });
  if (!confirmed) return null;
  // The backend refuses if the work changed since this preview (#5106).
  const result = await params.removeSubagent(params.workspaceId, preview.data);
  if (!result.success) {
    return { kind: "error", message: result.error ?? "Failed to remove the sub-agent" };
  }
  // A forced removal reports what it left behind (#5143); show it like the other forced paths.
  return result.warnings?.length
    ? { kind: "warning", message: formatWorkspaceRemoveWarnings(result.warnings) }
    : null;
}
