import type { WebContents } from "electron";

/**
 * SECURITY AUDIT: the app's only subframes are sandboxed srcdoc artifact frames (Artifacts
 * tab). CSP cannot stop such a frame from navigating itself (`location.href`,
 * a clicked link), and the new page would keep the same window and so the host bridge, without
 * the srcdoc's CSP. `will-navigate` only covers the main frame; every subframe navigation other
 * than loading a srcdoc is refused here. The renderer also drops a frame that loads twice
 * (frameNavigationGuard.tsx), which covers browser (server mode) hosts.
 */
export function isAllowedSubframeNavigation(isMainFrame: boolean, url: string): boolean {
  return isMainFrame || url === "about:srcdoc";
}

export function guardSubframeNavigation(contents: WebContents): void {
  contents.on("will-frame-navigate", (event) => {
    if (!isAllowedSubframeNavigation(event.isMainFrame, event.url)) event.preventDefault();
  });
}
