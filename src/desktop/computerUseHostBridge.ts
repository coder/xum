import { desktopCapturer, globalShortcut, screen, shell, systemPreferences } from "electron";

import {
  COMPUTER_USE_JPEG_QUALITY,
  COMPUTER_USE_STOP_ACCELERATOR,
} from "@/common/constants/computerUse";
import type {
  ComputerUsePermissionKind,
  ComputerUsePermissions,
} from "@/common/orpc/schemas/computerUse";
import { getErrorMessage } from "@/common/utils/errors";
import { pickPrimaryScreenSource, type DisplayInfo } from "@/node/services/computerUse/geometry";
import type {
  ComputerUseCapture,
  ComputerUseHostBridge,
} from "@/node/services/computerUse/hostBridge";
import { log } from "@/node/services/log";

const PRIVACY_SETTINGS_URLS: Record<ComputerUsePermissionKind, string> = {
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  screenRecording: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
};

function getPrimaryDisplay(): DisplayInfo {
  const display = screen.getPrimaryDisplay();
  return {
    id: display.id,
    bounds: { ...display.bounds },
    scaleFactor: display.scaleFactor,
    nativeOrigin: { ...display.nativeOrigin },
  };
}

/**
 * Electron main-process host capabilities for native computer use. Capture runs in-process
 * (desktopCapturer) so macOS attributes Screen Recording to Xum itself.
 */
export function createComputerUseHostBridge(): ComputerUseHostBridge {
  let stopShortcutRegistered = false;

  return {
    platform: process.platform,

    getPermissions(): ComputerUsePermissions | null {
      if (process.platform !== "darwin") {
        return null;
      }
      // Status checks must never prompt: only an explicit user click requests access.
      const screenStatus = systemPreferences.getMediaAccessStatus("screen");
      return {
        screenRecording:
          screenStatus === "granted"
            ? "granted"
            : screenStatus === "not-determined"
              ? "not-determined"
              : "denied",
        accessibility: systemPreferences.isTrustedAccessibilityClient(false) ? "granted" : "denied",
      };
    },

    async requestPermission(kind: ComputerUsePermissionKind): Promise<void> {
      if (process.platform !== "darwin") {
        return;
      }
      if (kind === "accessibility") {
        // Registers Xum in the Accessibility list and shows the system prompt.
        systemPreferences.isTrustedAccessibilityClient(true);
      } else {
        // A tiny capture registers Xum in the Screen Recording list and triggers the system prompt.
        await desktopCapturer
          .getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } })
          .catch((error: unknown) => {
            log.debug("[computerUse] screen recording probe failed", {
              error: getErrorMessage(error),
            });
          });
      }
      await shell.openExternal(PRIVACY_SETTINGS_URLS[kind]);
    },

    getPrimaryDisplay,

    async capturePrimaryDisplay(target): Promise<ComputerUseCapture> {
      const display = getPrimaryDisplay();
      const sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width: target.width, height: target.height },
      });
      const source = pickPrimaryScreenSource(
        sources,
        display.id,
        screen.getAllDisplays().length,
        process.platform
      );
      if (source == null) {
        throw new Error(
          "Could not identify the main display to capture. Computer use supports only the main " +
            "display, and cannot tell which screen that is here (for example, when one screen " +
            "is split into several monitors)."
        );
      }
      const thumbnail = source.thumbnail;
      if (thumbnail.isEmpty()) {
        throw new Error(
          "The screen capture was empty. On macOS, allow Xum in System Settings > Privacy & " +
            "Security > Screen Recording and restart Xum."
        );
      }
      const size = thumbnail.getSize();
      return {
        jpegBase64: thumbnail.toJPEG(COMPUTER_USE_JPEG_QUALITY).toString("base64"),
        width: size.width,
        height: size.height,
        display,
      };
    },

    setStopShortcut(handler): boolean {
      if (stopShortcutRegistered) {
        globalShortcut.unregister(COMPUTER_USE_STOP_ACCELERATOR);
        stopShortcutRegistered = false;
      }
      if (handler == null) {
        return true;
      }
      try {
        stopShortcutRegistered = globalShortcut.register(COMPUTER_USE_STOP_ACCELERATOR, handler);
      } catch (error) {
        log.warn("[computerUse] stop shortcut registration threw", {
          error: getErrorMessage(error),
        });
      }
      return stopShortcutRegistered;
    },
  };
}
