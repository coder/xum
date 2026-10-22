/**
 * The Node layer of DesktopNotifications: Electron's Notification API, moved here from
 * tools/notify.ts so that loop code does not import electron (local/no-host-imports).
 * This file is not an agent-loop file.
 */

import { getErrorMessage } from "@/common/utils/errors";
import {
  MAX_NOTIFICATION_BODY_LENGTH,
  MAX_NOTIFICATION_TITLE_LENGTH,
  truncateText,
  type DesktopNotifications,
} from "./desktopNotifications";

/**
 * Check if we're running in Electron environment
 */
function isElectronEnvironment(): boolean {
  return typeof process.versions.electron === "string";
}

/**
 * Send a system notification using Electron's Notification API.
 * When clicked, focuses the app and navigates to the specified workspace.
 * Returns true if notification was shown, false otherwise.
 */
async function sendElectronNotification(
  title: string,
  body?: string,
  workspaceId?: string
): Promise<{ success: boolean; error?: string }> {
  if (!isElectronEnvironment()) {
    return {
      success: false,
      error: "System notifications not supported (not running in Electron)",
    };
  }

  try {
    // eslint-disable-next-line no-restricted-syntax -- Electron is unavailable in `mux server`; avoid top-level import
    const { Notification, BrowserWindow } = await import("electron");

    if (!Notification.isSupported()) {
      return {
        success: false,
        error: "System notifications not supported on this platform",
      };
    }

    const notification = new Notification({
      title: truncateText(title, MAX_NOTIFICATION_TITLE_LENGTH),
      body: body ? truncateText(body, MAX_NOTIFICATION_BODY_LENGTH) : undefined,
      silent: false,
    });

    // Handle notification click - focus app and navigate to workspace
    notification.on("click", () => {
      const windows = BrowserWindow.getAllWindows();
      const mainWindow = windows[0];
      if (mainWindow) {
        // Restore if minimized, then focus
        if (mainWindow.isMinimized()) {
          mainWindow.restore();
        }
        mainWindow.focus();

        // Send IPC message to renderer to navigate to workspace
        if (workspaceId) {
          mainWindow.webContents.send("mux:notification-clicked", { workspaceId });
        }
      }
    });

    notification.show();

    return { success: true };
  } catch (error) {
    const message = getErrorMessage(error);
    return {
      success: false,
      error: `Failed to send notification: ${message}`,
    };
  }
}

export const electronDesktopNotifications: DesktopNotifications = {
  show: (request) => sendElectronNotification(request.title, request.body, request.workspaceId),
};
