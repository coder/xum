import { useEffect, useLayoutEffect } from "react";
import { useRouter } from "@/browser/contexts/RouterContext";
import { useWorkspaceMetadata } from "@/browser/contexts/WorkspaceContext";
import { removeWorkspaceView, viewWorkspaceId } from "./removeWorkspaceView";

/**
 * ChatPane: its live chat view replaces the static view of the same workspace once it is loaded,
 * or once its history read failed. A failed read never sets "loaded" (the store keeps retrying),
 * and the live view then shows the cached rows with the failure banner, so the static view goes.
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

/**
 * Whether no chat view of the view's workspace will come: the route shows another page, or the
 * workspace list loaded without that workspace or failed to load, or its runtime is incompatible
 * (AIView then shows a warning instead of a chat view).
 */
function noHandoffComing(
  viewOf: string,
  currentWorkspaceId: string | null,
  list: ReturnType<typeof useWorkspaceMetadata>
): boolean {
  const metadata = list.workspaceMetadata.get(viewOf);
  if (currentWorkspaceId !== viewOf || list.loadError !== null) return true;
  return list.loaded && (!metadata || !!metadata.incompatibleRuntime);
}

/**
 * App: removes the static view whenever noHandoffComing. App mounts it outside the page's lazy
 * boundary, so it is never suspended with the page, and a failed page's Reload fallback removes
 * the view (LazyFeature). AppLoader's FirstRunViewConnectionGuard removes it for the token prompt,
 * a startup error and the reconnect screen, because App is not mounted then. The view is inert and
 * does not scroll, so a tap or a key would reach the hidden live UI under it: the first one removes
 * the view too. No timers.
 */
export function WorkspaceViewGuard(): null {
  const { currentWorkspaceId } = useRouter();
  const list = useWorkspaceMetadata();
  useLayoutEffect(() => {
    const viewOf = viewWorkspaceId();
    if (viewOf !== undefined && noHandoffComing(viewOf, currentWorkspaceId, list)) {
      removeWorkspaceView();
    }
  }, [currentWorkspaceId, list]);
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
