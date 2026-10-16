import { useEffect, useLayoutEffect } from "react";
import { useAPI } from "@/browser/contexts/API";
import { useRouter } from "@/browser/contexts/RouterContext";
import { useWorkspaceMetadata } from "@/browser/contexts/WorkspaceContext";
import { WORKSPACE_VIEW_ID, WORKSPACE_VIEW_WORKSPACE_ATTR } from "@/common/constants/workspaceView";

/** The workspace of the static view on screen, or undefined when there is none. */
function viewWorkspaceId(): string | undefined {
  const view = document.getElementById(WORKSPACE_VIEW_ID);
  return view ? (view.getAttribute(WORKSPACE_VIEW_WORKSPACE_ATTR) ?? "") : undefined;
}

/** Removes the static workspace view. Callers do it whenever the live app will not replace it. */
export function removeWorkspaceView(): void {
  document.getElementById(WORKSPACE_VIEW_ID)?.remove();
}

/**
 * ChatPane: its live chat view replaces the static view of the same workspace once it is loaded,
 * or once its history read failed. A failed read never sets "loaded" (the store keeps retrying), and
 * the live view then shows the cached rows with the failure banner, so the static view must go.
 */
export function useWorkspaceViewHandoff(
  workspaceId: string,
  loaded: boolean,
  replayFailed: boolean
): void {
  useLayoutEffect(() => {
    if ((loaded || replayFailed) && viewWorkspaceId() === workspaceId) removeWorkspaceView();
  }, [workspaceId, loaded, replayFailed]);
}

const BLOCKING_STATUSES = new Set(["auth_required", "error", "reconnecting"]);

/**
 * App: removes the static view whenever the live app will not show its workspace's chat view: the
 * token prompt, a startup error or the reconnect screen; a route to another page; or a workspace
 * list that loaded without the view's workspace, or failed to load. The view is inert and does not scroll, so a tap or
 * a key would reach the hidden live UI under it: the first one removes the view too. No timers.
 */
export function WorkspaceViewGuard(): null {
  const { status } = useAPI();
  const { currentWorkspaceId } = useRouter();
  const { workspaceMetadata, loaded, loadError } = useWorkspaceMetadata();
  const blocked = BLOCKING_STATUSES.has(status);
  useLayoutEffect(() => {
    const viewOf = viewWorkspaceId();
    if (viewOf === undefined) return;
    const missing = (loaded && !workspaceMetadata.has(viewOf)) || loadError !== null;
    if (blocked || currentWorkspaceId !== viewOf || missing) removeWorkspaceView();
  }, [blocked, currentWorkspaceId, loaded, loadError, workspaceMetadata]);
  useEffect(() => {
    if (viewWorkspaceId() === undefined) return;
    const options = { capture: true, once: true } as const;
    window.addEventListener("pointerdown", removeWorkspaceView, options);
    window.addEventListener("keydown", removeWorkspaceView, options);
    return () => {
      window.removeEventListener("pointerdown", removeWorkspaceView, options);
      window.removeEventListener("keydown", removeWorkspaceView, options);
    };
  }, []);
  return null;
}
