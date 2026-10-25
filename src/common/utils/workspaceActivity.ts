import type { WorkspaceActivitySnapshot } from "@/common/types/workspace";

/**
 * Whether a workspace is "working": an agent stream is active, or the workspace is
 * waiting to be woken by an armed background bash monitor or an unfinished workflow
 * run. Backend consumers that gate side effects on agent activity (heartbeats, the
 * desktop keep-awake blocker) share it so they agree with each other. Unlike the
 * sidebar's "working" badge, a stream paused on `ask_user_question` still counts as
 * busy, because the workspace activity stream does not carry that pause.
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
