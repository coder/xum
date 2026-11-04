import type { APIClient } from "@/browser/contexts/API";
import type { ConfirmDialogOptions } from "@/browser/contexts/ConfirmDialogContext";
import type { WorkspaceRemoveResult } from "@/common/types/workspace";

type RemoveOptions = Parameters<APIClient["workspace"]["remove"]>[0]["options"];

/** Retry removal once after the user acknowledges the listed unknown process records. */
export async function confirmAndRemoveWorkspace(params: {
  removeWorkspace: (workspaceId: string, options?: RemoveOptions) => Promise<WorkspaceRemoveResult>;
  confirm: (options: ConfirmDialogOptions) => Promise<boolean>;
  workspaceId: string;
  options?: RemoveOptions;
}): Promise<WorkspaceRemoveResult> {
  const result = await (params.options === undefined
    ? params.removeWorkspace(params.workspaceId)
    : params.removeWorkspace(params.workspaceId, params.options));
  if (result.success) return result;

  const records = result.backgroundProcesses ?? [];
  if (records.some((record) => record.state === "running")) return result;
  const unknownRecords = records.filter((record) => record.state === "unknown");
  if (unknownRecords.length === 0) return result;

  // Empty or damaged records do not prove that their commands stopped.
  const confirmed = await params.confirm({
    title: "Remove workspace with unknown process activity?",
    description:
      "Xum cannot verify whether these background commands stopped. Review each process record before continuing.",
    details: {
      label: "Unknown process records",
      items: unknownRecords.map((record) => `${record.recordPath}: ${record.reason}`),
    },
    warning:
      "Commands can still run. Deleting this workspace can lose data. Continue only if you accept these risks.",
    confirmLabel: "Accept risk and remove workspace",
    confirmVariant: "destructive",
  });
  if (!confirmed) return result;

  // Keep this acknowledgment separate from force and descendant removal permissions.
  // Return any changed scope or activity without another prompt or automatic retry.
  return params.removeWorkspace(params.workspaceId, {
    ...params.options,
    acknowledgedUnknownProcessRecords: unknownRecords.map((record) => record.recordPath),
  });
}
