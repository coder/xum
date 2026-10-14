import { useEffect, useLayoutEffect, useRef } from "react";
import type { RuntimeStatus } from "@/browser/stores/RuntimeStatusStore";
import {
  isAltGraphPressed,
  isDialogOpen,
  isCommandPaletteTarget,
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
 * Ctrl+Alt chords: AltGr types characters with the same modifiers in text fields. A modal
 * covers the workspace, so its keys must not act behind it. isDialogOpen() does not see the
 * command palette, and a click on the palette outside its input focuses the palette itself
 * (cmdk's root takes focus), so check the palette too (#6434).
 */
function keysMayAct(event: KeyboardEvent): boolean {
  return !targetOwnsKeys(event.target) && !isAltGraphPressed(event) && !isDialogOpen();
}

/** A text field or the open command palette handles its own keys. */
function targetOwnsKeys(target: EventTarget | null): boolean {
  return isEditableElement(target) || isCommandPaletteTarget(target);
}

/**
 * Fork workspace and Stop container for the selected workspace (#6328). The workspace actions
 * menu handles the same keys for its own workspace while it is open, before they reach this
 * window listener.
 */
export function useWorkspaceActionKeybinds(options: WorkspaceActionKeybindOptions): void {
  // ProjectSidebar is not compiled (React Compiler skip, #4439), so its inline callbacks are new
  // on every render. Keep the latest options in a ref so the window listener is added once per
  // selected workspace, not on every sidebar render (perf owner on #6398).
  const optionsRef = useRef(options);
  useLayoutEffect(() => {
    optionsRef.current = options;
  });
  const { selectedWorkspaceId } = options;
  useEffect(() => {
    if (selectedWorkspaceId == null) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!keysMayAct(e)) return;
      const current = optionsRef.current;
      const metadata = current.getWorkspaceMetadata(selectedWorkspaceId);
      if (!metadata) return;
      const status = current.runtimeStatusStore.getStatus(selectedWorkspaceId);
      const action = getKeyAction(e, metadata, status);
      if (action === null) return;
      e.preventDefault();
      // A held key auto-repeats: each repeat would start another fork or stop request.
      if (e.repeat) return;
      (action === "fork" ? current.onForkWorkspace : current.onStopRuntime)(selectedWorkspaceId);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedWorkspaceId]);
}
