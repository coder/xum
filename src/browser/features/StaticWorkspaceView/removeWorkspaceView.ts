import { WORKSPACE_VIEW_ID, WORKSPACE_VIEW_WORKSPACE_ATTR } from "@/common/constants/workspaceView";

// DOM only, no app imports: AppLoader, main.tsx and LazyFeature (imported almost everywhere) use it.

/** The workspace of the static view on screen, or undefined when there is none. */
export function viewWorkspaceId(): string | undefined {
  const view = document.getElementById(WORKSPACE_VIEW_ID);
  return view ? (view.getAttribute(WORKSPACE_VIEW_WORKSPACE_ATTR) ?? "") : undefined;
}

/** Removes the static workspace view. Callers do it whenever the live app will not replace it. */
export function removeWorkspaceView(): void {
  document.getElementById(WORKSPACE_VIEW_ID)?.remove();
}
