import { useCallback } from "react";
import { useAPI } from "@/browser/contexts/API";
import type { RuntimeConfig } from "@/common/types/runtime";
import { isSSHRuntime, isDevcontainerRuntime } from "@/common/types/runtime";
import {
  createTerminalSession,
  openTerminalPopout,
  TerminalDialogBusyError,
  TerminalPopupBlockedError,
  type TerminalSessionCreateOptions,
} from "@/browser/utils/terminal";
import { showFeedbackToast } from "@/browser/utils/feedbackToast";
import { getErrorMessage } from "@/common/utils/errors";

/**
 * Hook to open a terminal window for a workspace.
 * Handles the difference between Desktop (Electron) and Browser (Web) environments.
 *
 * For SSH/Devcontainer workspaces: Always opens a web-based xterm.js terminal that
 * connects through the backend PTY service (works in both browser and Electron modes).
 *
 * For local workspaces in Electron: Opens the user's native terminal emulator
 * (Ghostty, Terminal.app, etc.) with the working directory set to the workspace path.
 *
 * For local workspaces in browser: Opens a web-based xterm.js terminal in a popup window.
 */
export function useOpenTerminal() {
  const { api } = useAPI();

  return useCallback(
    async (
      workspaceId: string,
      runtimeConfig?: RuntimeConfig,
      options?: TerminalSessionCreateOptions
    ) => {
      if (!api) return;

      // Check if running in browser mode
      // window.api is only available in Electron (set by preload.ts)
      // If window.api exists, we're in Electron; if not, we're in browser mode
      const isBrowser = !window.api;
      const isSSH = isSSHRuntime(runtimeConfig);
      const isDevcontainer = isDevcontainerRuntime(runtimeConfig);

      // SSH/Devcontainer workspaces always use web terminal (in browser popup or Electron window)
      // because the PTY service handles the SSH/container connection.
      //
      // Callers (e.g. WorkspaceMenuBar, the markdown Run button's mobile path) discard the
      // returned promise via `void`, so we must catch rejections here to avoid an unhandled
      // promise rejection that the user perceives as the app silently freezing/crashing.
      let createdSessionId: string | null = null;
      try {
        if (isBrowser || isSSH || isDevcontainer) {
          // Create terminal session first - window needs sessionId to connect.
          const session = await createTerminalSession(api, workspaceId, options);
          createdSessionId = session.sessionId;
          // Awaited so a rejected `terminal.openWindow` (e.g., Electron
          // terminalWindowManager failure) is observed by this try/catch instead of
          // becoming an unhandled rejection that looks like a silent freeze.
          await openTerminalPopout(api, workspaceId, session.sessionId);
        } else {
          await api.terminal.openNative({ workspaceId });
        }
      } catch (err) {
        if (err instanceof TerminalPopupBlockedError && createdSessionId != null) {
          // No window will attach to this session. Close it, or the right sidebar would later
          // adopt the hidden shell as a terminal tab.
          api.terminal.close({ sessionId: createdSessionId }).catch((closeErr: unknown) => {
            console.warn("[useOpenTerminal] Failed to close unused terminal session:", closeErr);
          });
        }
        // The open dialog covers every entry point, so only a repeated tap or shortcut made while
        // the first session was being created gets here: the dialog shown is its answer. A toast
        // would also sit hidden behind the dialog until it closed.
        if (err instanceof TerminalDialogBusyError) return;
        console.error("[useOpenTerminal] Failed to open terminal:", err);
        // Callers fire and forget, so this toast is the only sign that the click failed.
        showFeedbackToast({
          type: "error",
          title: "Could not open terminal",
          message: getErrorMessage(err),
        });
      }
    },
    [api]
  );
}
