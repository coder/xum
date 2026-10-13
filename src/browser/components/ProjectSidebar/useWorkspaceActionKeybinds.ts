import { useEffect } from "react";
import type { RuntimeStatus } from "@/browser/stores/RuntimeStatusStore";
import {
  isAltGraphPressed,
  isEditableElement,
  KEYBINDS,
  matchesKeybind,
} from "@/browser/utils/ui/keybinds";
import { hasWorkspaceRepository } from "@/browser/utils/workspaceCapabilities";
import { isDevcontainerRuntime } from "@/common/types/runtime";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";

interface WorkspaceActionKeybindOptions {
  selectedWorkspaceId: string | null | undefined;
  getWorkspaceMetadata: (workspaceId: string) => FrontendWorkspaceMetadata | undefined;
  runtimeStatusStore: { getStatus: (workspaceId: string) => RuntimeStatus | null };
  onForkWorkspace: (workspaceId: string) => void;
  onStopRuntime: (workspaceId: string) => void;
}

/**
 * Which workspace action a key starts, or null. Each key does nothing where its menu row would
 * not show: a scratch chat has no repository to fork, and only a running devcontainer can stop.
 */
function getKeyAction(
  event: KeyboardEvent,
  metadata: FrontendWorkspaceMetadata,
  runtimeStatus: RuntimeStatus | null
): "fork" | "stopRuntime" | null {
  if (matchesKeybind(event, KEYBINDS.FORK_WORKSPACE)) {
    return hasWorkspaceRepository(metadata) ? "fork" : null;
  }
  if (matchesKeybind(event, KEYBINDS.STOP_WORKSPACE_RUNTIME)) {
    const running = isDevcontainerRuntime(metadata.runtimeConfig) && runtimeStatus === "running";
    return running ? "stopRuntime" : null;
  }
  return null;
}

/**
 * Fork workspace and Stop container for the selected workspace (#6328). The workspace actions
 * menu handles the same keys for its own workspace while it is open, before they reach this
 * window listener.
 */
export function useWorkspaceActionKeybinds(options: WorkspaceActionKeybindOptions): void {
  const { selectedWorkspaceId, getWorkspaceMetadata, runtimeStatusStore } = options;
  const { onForkWorkspace, onStopRuntime } = options;
  useEffect(() => {
    if (selectedWorkspaceId == null) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl+Alt chords: AltGr types characters with the same modifiers in text fields.
      if (isEditableElement(e.target) || isAltGraphPressed(e)) return;
      const metadata = getWorkspaceMetadata(selectedWorkspaceId);
      if (!metadata) return;
      const action = getKeyAction(e, metadata, runtimeStatusStore.getStatus(selectedWorkspaceId));
      if (action === null) return;
      e.preventDefault();
      (action === "fork" ? onForkWorkspace : onStopRuntime)(selectedWorkspaceId);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    selectedWorkspaceId,
    getWorkspaceMetadata,
    runtimeStatusStore,
    onForkWorkspace,
    onStopRuntime,
  ]);
}
