import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "@/node/orpc/router";
import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";
import { getErrorMessage } from "@/common/utils/errors";
import { forkWorkspace } from "@/browser/utils/chatCommands";
import type { RuntimeStatusStore } from "@/browser/stores/RuntimeStatusStore";

// One handler per menu action, shared by the sidebar rows and the workspace menu bar (#6202).
// Each returns the error to show, or null on success; the caller anchors the error popover.

type ApiClient = RouterClient<AppRouter> | null;

export async function forkWorkspaceFromMenu(
  api: ApiClient,
  workspaceId: string
): Promise<string | null> {
  if (!api) return "Not connected to server";
  try {
    const result = await forkWorkspace({ client: api, sourceWorkspaceId: workspaceId });
    return result.success ? null : (result.error ?? "Failed to fork workspace");
  } catch (error) {
    // IPC/transport failures throw instead of returning { success: false }.
    return getErrorMessage(error);
  }
}

export async function stopWorkspaceRuntime(
  api: ApiClient,
  runtimeStatusStore: RuntimeStatusStore,
  workspaceId: string
): Promise<string | null> {
  if (!api) return "Not connected to server";
  try {
    const result = await api.workspace.stopRuntime({ workspaceId });
    if (!result.success) return result.error ?? "Failed to stop container";
    // Clear the cached running state at once, so both menus hide Stop container and the
    // sidebar's running indicator without each row keeping its own optimistic state.
    runtimeStatusStore.invalidateWorkspace(workspaceId);
    return null;
  } catch (error) {
    return getErrorMessage(error);
  }
}

/** The sidebar owns title editing (TitleEditProvider), so both menus ask it by event. */
export function requestGenerateWorkspaceTitle(workspaceId: string): void {
  window.dispatchEvent(
    createCustomEvent(CUSTOM_EVENTS.WORKSPACE_GENERATE_TITLE_REQUESTED, { workspaceId })
  );
}

/** Where an action's error popover opens: just right of the element the user clicked. */
export function getErrorAnchor(
  element: HTMLElement | null | undefined
): { top: number; left: number } | undefined {
  if (!element) return undefined;
  const rect = element.getBoundingClientRect();
  return { top: rect.top + window.scrollY, left: rect.right + 10 };
}
