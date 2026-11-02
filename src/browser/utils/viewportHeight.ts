import { isIosStandaloneWebApp } from "@/browser/utils/env";

export const APP_VIEWPORT_HEIGHT_PROPERTY = "--app-viewport-height";

function syncViewportHeight(): void {
  const viewport = window.visualViewport;
  // The software keyboard resizes only the visual viewport: iOS fires no window resize when it
  // opens or closes. A height read from innerHeight on a resize while it was up stuck, and left a
  // blank band under the shell after it closed. Height times scale ignores pinch zoom.
  const height =
    viewport != null && viewport.height > 0
      ? Math.round(viewport.height * viewport.scale)
      : window.innerHeight;
  document.documentElement.style.setProperty(APP_VIEWPORT_HEIGHT_PROPERTY, `${height}px`);
  // To reveal the focused field over the keyboard iOS scrolls the window, which moved the whole
  // shell up and hid the header. The shell now fits above the keyboard, so undo that scroll
  // (unless pinch zoomed in, where scrolling is the user's pan).
  if (window.scrollY !== 0 && (viewport == null || viewport.scale === 1)) {
    window.scrollTo(0, 0);
  }
}

/**
 * Size the app shell from the visual viewport on iOS home-screen web apps, where iOS 26 can
 * resolve 100dvh as if a browser toolbar were still present and leave a blank band under
 * the footer, and the keyboard resizes nothing else. Other environments keep the CSS dvh
 * fallback.
 */
export function installViewportHeightSync(): () => void {
  if (!isIosStandaloneWebApp()) {
    return () => undefined;
  }

  syncViewportHeight();
  window.addEventListener("resize", syncViewportHeight);
  window.visualViewport?.addEventListener("resize", syncViewportHeight);
  window.visualViewport?.addEventListener("scroll", syncViewportHeight);

  // Turning an iPad from landscape to portrait can fire resize while innerHeight still holds the
  // landscape height, and no later resize follows, so the app kept filling only the old height.
  // A fixed box spanning the viewport resizes once the rotated layout exists; sync again then.
  const viewportBox = document.createElement("div");
  viewportBox.setAttribute("aria-hidden", "true");
  viewportBox.style.cssText =
    "position:fixed;inset:0;visibility:hidden;pointer-events:none;z-index:-1";
  let observer: ResizeObserver | undefined;
  try {
    document.body.appendChild(viewportBox);
    if (typeof window.ResizeObserver === "function") {
      observer = new window.ResizeObserver(syncViewportHeight);
      observer.observe(viewportBox);
    }
  } catch (error) {
    // main.tsx calls this before React mounts, and startup must never fail on the probe:
    // keep the resize listener alone.
    console.error("Viewport height sync: could not observe the viewport", error);
    observer?.disconnect();
    viewportBox.remove();
  }

  return () => {
    window.removeEventListener("resize", syncViewportHeight);
    window.visualViewport?.removeEventListener("resize", syncViewportHeight);
    window.visualViewport?.removeEventListener("scroll", syncViewportHeight);
    observer?.disconnect();
    viewportBox.remove();
    document.documentElement.style.removeProperty(APP_VIEWPORT_HEIGHT_PROPERTY);
  };
}

/**
 * iOS WebKit zooms the page when a text field below 16px gets focus. `maximum-scale=1` stops that
 * focus zoom, and iOS 10+ ignores it for pinch zoom, so users can still enlarge text (WCAG 1.4.4).
 * Android honors `maximum-scale` and would lose pinch zoom, so index.html leaves it out (#5972) and
 * only iOS gets it here. The earlier fix forced text fields to 16px on phones instead, which made
 * the composer larger than the 14px transcript and unlike desktop.
 * `-webkit-touch-callout` is supported only by iOS WebKit (same probe as the `ios-standalone` variant).
 */
export function installIosFocusZoomGuard(): void {
  // jsdom (tests/ui) has no global CSS.
  if (typeof CSS === "undefined" || !CSS.supports("-webkit-touch-callout", "none")) return;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (meta == null || /maximum-scale/i.test(meta.content)) return;
  meta.content = `${meta.content}, maximum-scale=1`;
}
