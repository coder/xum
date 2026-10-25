/**
 * Desktop titlebar utilities for Electron's integrated titlebar.
 *
 * In Electron mode (window.api exists), the native titlebar is hidden and we need:
 * 1. Drag regions for window dragging
 * 2. Insets for native window controls (traffic lights on mac, overlay on win/linux)
 *
 * In browser/mux server mode, these are no-ops.
 *
 * ## Architecture
 *
 * Titlebar insets are centralized via CSS custom properties:
 * - `--titlebar-left-inset`: Space for macOS traffic lights, or for overlay controls on the left
 * - `--titlebar-right-inset`: Space for overlay controls on the right (win32/linux)
 *
 * Call `initTitlebarInsets()` once at app startup to set these properties on :root.
 * Components then use `var(--titlebar-left-inset)` in CSS/styles without needing
 * to import platform detection logic.
 */

/**
 * Whether we're running in Electron desktop mode.
 * Checks for getIsRosetta function which only exists in real Electron preload,
 * not in story mocks that just set window.api for testing specific features.
 */
export function isDesktopMode(): boolean {
  return typeof window !== "undefined" && typeof window.api?.getIsRosetta === "function";
}

/**
 * Returns the platform string in desktop mode, undefined in browser mode.
 */
export function getDesktopPlatform(): NodeJS.Platform | undefined {
  return window.api?.platform;
}

/**
 * Left inset (in pixels) to reserve for macOS traffic lights.
 * Only applies in Electron + macOS.
 *
 * The value accounts for the traffic lights (~68px) plus comfortable padding.
 */
export const MAC_TRAFFIC_LIGHTS_INSET = 80;

/**
 * Fallback right inset (in pixels) for Windows/Linux overlay buttons when the
 * overlay reports no geometry. The value accounts for min/max/close on Windows.
 */
const WIN_LINUX_OVERLAY_INSET = 138;

// Windows/Linux draw native controls in a Window Controls Overlay. Electron 43+ puts the
// Linux controls where the desktop does (left, right, or only a close button on GNOME),
// so reserve the space the overlay reports instead of a fixed right inset.
const OVERLAY_LEFT_INSET = "env(titlebar-area-x, 0px)";
const OVERLAY_RIGHT_INSET = `calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, calc(100vw - ${WIN_LINUX_OVERLAY_INSET}px)))`;

/**
 * Desktop titlebar height in pixels. Keep in sync with the Tailwind classes below.
 */
export const DESKTOP_TITLEBAR_HEIGHT_PX = 36;

/**
 * Tailwind height classes for the desktop titlebar.
 * Use these in components that need to align with the titlebar height.
 */
export const DESKTOP_TITLEBAR_HEIGHT_CLASS = "h-9";
export const DESKTOP_TITLEBAR_MIN_HEIGHT_CLASS = "min-h-9";

/**
 * Returns the left inset needed for macOS traffic lights.
 * Returns 0 if not in desktop mode or not on macOS.
 */
export function getTitlebarLeftInset(): number {
  if (!isDesktopMode()) return 0;
  if (getDesktopPlatform() === "darwin") return MAC_TRAFFIC_LIGHTS_INSET;
  return 0;
}

/**
 * Initialize CSS custom properties for titlebar insets. Call once at app startup.
 *
 * Components can then use these variables without importing platform logic:
 * ```css
 * padding-left: var(--titlebar-left-inset, 0px);
 * ```
 */
export function initTitlebarInsets(): void {
  if (typeof document === "undefined") return;

  const platform = isDesktopMode() ? getDesktopPlatform() : undefined;
  const overlay = platform === "win32" || platform === "linux";
  const root = document.documentElement;
  root.style.setProperty(
    "--titlebar-left-inset",
    overlay ? OVERLAY_LEFT_INSET : `${getTitlebarLeftInset()}px`
  );
  root.style.setProperty("--titlebar-right-inset", overlay ? OVERLAY_RIGHT_INSET : "0px");
}
