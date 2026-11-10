import { useEffect, useState } from "react";
import { workspaceStore } from "@/browser/stores/WorkspaceStore";

/** While the window is visible, re-list this often to catch writes no tool event reports. */
const ARTIFACTS_POLL_MS = 3000;

/**
 * A tick that bumps whenever the workspace's artifacts folder may have changed, for the
 * Artifacts panel and the Agent interface view to re-list on. `listInFlightRef` is set while
 * the caller's list request runs, so a slow walk is not aborted by the next poll tick.
 */
export function useArtifactsRefreshTick(
  workspaceId: string,
  options: { online: boolean; listInFlightRef: React.RefObject<boolean>; enabled?: boolean }
) {
  const [tick, setTick] = useState(0);
  const enabled = options.enabled ?? true;
  const { online, listInFlightRef } = options;

  // Re-list after the agent's file edits and bash commands, the usual ways it writes files.
  useEffect(() => {
    if (!enabled) return;
    return workspaceStore.subscribeFileModifyingTool((wsId) => {
      if (wsId === workspaceId) setTick((value) => value + 1);
    }, workspaceId);
  }, [workspaceId, enabled]);

  // Writes by scripts or other tools emit no event, so poll while the window is visible. Not
  // while Xum reconnects: each poll re-reads canvas data files, and those reads wait for the
  // connection (useArtifactAssetReader), so ticks during an outage would only pile them up.
  useEffect(() => {
    if (!online || !enabled) return;
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible" && !listInFlightRef.current) {
        setTick((value) => value + 1);
      }
    }, ARTIFACTS_POLL_MS);
    return () => window.clearInterval(interval);
  }, [online, enabled, listInFlightRef]);

  return [tick, setTick] as const;
}
