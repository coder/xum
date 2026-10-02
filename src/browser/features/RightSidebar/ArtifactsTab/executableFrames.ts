import { isDesktopMode } from "@/browser/hooks/useDesktopTitlebar";

/**
 * SECURITY AUDIT: whether executable artifact frames (HTML/SVG artifacts, MCP App views) may be
 * mounted at all. A sandboxed srcdoc frame can navigate itself (`location.href`, a clicked link),
 * and CSP does not cover navigation. Only the desktop app refuses such navigations before they
 * start (main.ts will-frame-navigate, subframeNavigation.ts); in browser/server mode the request
 * (and any data in its URL) would leave before the renderer could notice. So outside the desktop
 * app these frames are never mounted and no postMessage bridge is attached (fail closed); callers
 * show the escaped source or a notice instead. Remote-server desktop windows get no local
 * preload, so they fail closed too.
 *
 * The signal is the desktop preload bridge (`window.api`, see isDesktopMode).
 */
export function canMountExecutableArtifactFrames(): boolean {
  return isDesktopMode();
}

export const DESKTOP_ONLY_PREVIEW_NOTICE = "Interactive preview is available in the desktop app.";
