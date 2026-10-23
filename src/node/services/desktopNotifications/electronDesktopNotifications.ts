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

/** The parts of the electron module that this layer uses. Tests pass a fake one. */
export interface ElectronNotificationApi {
  Notification: {
    isSupported(): boolean;
    new (options: { title: string; body?: string; silent: boolean }): {
      on(event: "click", listener: () => void): unknown;
      show(): void;
    };
  };
  BrowserWindow: {
    getAllWindows(): Array<{
      isMinimized(): boolean;
      restore(): void;
      focus(): void;
      webContents: { send(channel: string, payload: { workspaceId: string }): void };
    }>;
  };
}

export interface ElectronHost {
  /** True when this process runs in Electron. */
  isElectron(): boolean;
  /** Imports electron. Called only when isElectron() is true. */
  loadElectron(): Promise<ElectronNotificationApi>;
}

const realElectronHost: ElectronHost = {
  isElectron: () => typeof process.versions.electron === "string",
  loadElectron: async () => {
    // eslint-disable-next-line no-restricted-syntax -- Electron is unavailable in `mux server`; avoid top-level import
    const { Notification, BrowserWindow } = await import("electron");
    return { Notification, BrowserWindow };
  },
};

/**
 * Send a system notification using Electron's Notification API.
 * When clicked, focuses the app and navigates to the specified workspace.
 * Returns true if notification was shown, false otherwise.
 */
async function sendElectronNotification(
  host: ElectronHost,
  title: string,
  body?: string,
  workspaceId?: string
): Promise<{ success: boolean; error?: string }> {
  if (!host.isElectron()) {
    return {
      success: false,
      error: "System notifications not supported (not running in Electron)",
    };
  }

  try {
    const { Notification, BrowserWindow } = await host.loadElectron();

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

/** The Node layer on a given electron host. Tests pass a fake host. */
export function createElectronDesktopNotifications(host: ElectronHost): DesktopNotifications {
  return {
    show: (request) =>
      sendElectronNotification(host, request.title, request.body, request.workspaceId),
  };
}

export const electronDesktopNotifications = createElectronDesktopNotifications(realElectronHost);
