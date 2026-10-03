import { isDesktopMode } from "@/browser/hooks/useDesktopTitlebar";

/**
 * SECURITY AUDIT: whether the host may talk to executable artifact frames (HTML/SVG artifacts,
 * MCP App views) over postMessage. A sandboxed srcdoc frame can navigate itself
 * (`location.href`, a tapped link), and CSP does not cover navigation. Only the desktop app
 * refuses such navigations before they start (main.ts will-frame-navigate,
 * subframeNavigation.ts). In browser/server mode the destination page keeps the same
 * contentWindow, and its scripts run before the iframe's second `load` event
 * (frameNavigationGuard.tsx), so the host cannot tell its messages from the artifact's.
 *
 * So outside the desktop app (phones included):
 * - HTML/SVG artifacts still mount, because previews on phones were requested, but the host
 *   attaches no message listener: send, setState, annotate and key forwarding do nothing.
 *   Accepted risk: one navigation request can carry what the page already holds (its content
 *   and the saved state baked into the srcdoc) to any URL.
 * - MCP App views do not mount at all: they cannot work without the bridge.
 *
 * Remote-server desktop windows get no local preload, so they count as browser mode. The
 * signal is the desktop preload bridge (`window.api`, see isDesktopMode).
 */
export function canBridgeExecutableFrames(): boolean {
  return isDesktopMode();
}

export const DESKTOP_ONLY_PREVIEW_NOTICE = "Interactive preview is available in the desktop app.";
