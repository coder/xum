import type {
  ComputerUsePermissionKind,
  ComputerUsePermissions,
} from "@/common/orpc/schemas/computerUse";

import type { DisplayInfo } from "./geometry";

export interface ComputerUseCapture {
  jpegBase64: string;
  width: number;
  height: number;
  /** The display as it was when this image was captured. */
  display: DisplayInfo;
}

/**
 * Host capabilities only the Electron main process has (screen capture, display geometry,
 * macOS privacy permissions, global shortcuts). The desktop app injects an implementation;
 * without one (`xum server`, browser mode) computer use is unsupported.
 */
export interface ComputerUseHostBridge {
  platform: NodeJS.Platform;
  /** Never prompts. Null where the OS has no such gate (Linux). */
  getPermissions(): ComputerUsePermissions | null;
  /** Only called from an explicit user click: may show a system prompt and open System Settings. */
  requestPermission(kind: ComputerUsePermissionKind): Promise<void>;
  getPrimaryDisplay(): DisplayInfo;
  capturePrimaryDisplay(target: { width: number; height: number }): Promise<ComputerUseCapture>;
  /** Registers (handler) or unregisters (null) the global stop shortcut; false if registration failed. */
  setStopShortcut(handler: (() => void) | null): boolean;
}
