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
  /** The live client now (null while offline): read again after the user confirms. */
  getApi: () => APIClient | null;
  confirm: (options: ConfirmDialogOptions) => Promise<boolean>;
  removeSubagent: (
    workspaceId: string,
    acknowledgedWork: Parameters<APIClient["tasks"]["remove"]>[0]["acknowledgedWork"]
  ) => Promise<WorkspaceRemoveResult>;
  workspaceId: string;
  title: string;
}): Promise<SubagentRemovalNotice> {
  const notConnected = { kind: "error", message: "API not connected" } as const;
  const api = params.getApi();
  if (api == null) return notConnected;
  // Palette actions run fire-and-forget, so a transport failure must come back as an error too.
  let preview: Awaited<ReturnType<APIClient["tasks"]["previewRemoval"]>>;
  try {
    preview = await api.tasks.previewRemoval({ taskId: params.workspaceId });
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
  // The connection can drop while the dialog is open.
  if (params.getApi() == null) return notConnected;
  // The backend refuses if the work changed since this preview (#5106).
  return removalNotice(await params.removeSubagent(params.workspaceId, preview.data));
}

function removalNotice(result: WorkspaceRemoveResult): SubagentRemovalNotice {
  if (!result.success) {
    return { kind: "error", message: result.error ?? "Failed to remove the sub-agent" };
  }
  // A forced removal reports what it left behind (#5143); show it like the other forced paths.
  return result.warnings?.length
    ? { kind: "warning", message: formatWorkspaceRemoveWarnings(result.warnings) }
    : null;
}
