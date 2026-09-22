import type { WorkspaceActivitySnapshot } from "@/common/types/workspace";

/**
 * Whether a workspace is "working": an agent stream is active, or the workspace is
 * waiting to be woken by an armed background bash monitor or an unfinished workflow
 * run. This is the same notion the sidebar uses to mark a workspace as busy; consumers
 * that gate side effects on agent activity (e.g. the desktop keep-awake blocker) must
 * share it so they never disagree with what the user sees.
 *
 * `null`/`undefined` (workspace removed or never seen) is idle.
 */
export function isWorkspaceActivityBusy(
  activity: WorkspaceActivitySnapshot | null | undefined
): boolean {
  if (!activity) {
    return false;
  }
  return (
    activity.streaming ||
    (activity.activeBashMonitorCount ?? 0) > 0 ||
    (activity.activeWorkflowRunCount ?? 0) > 0
  );
}
