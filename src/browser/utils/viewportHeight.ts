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
 * the footer, and the keyboard resizes nothing else. Other environments keep the CSS dvh fallback.
 */
export function installViewportHeightSync(): () => void {
  if (!isIosStandaloneWebApp()) {
    return () => undefined;
  }

  // Rotating an iPad can fire resize while innerHeight still holds the pre-rotation height, and no
  // later resize follows, so the app kept filling only the old height. The rotated layout exists by
  // the next frame, so sync once more then.
  const syncAfterLayout = (): void => {
    syncViewportHeight();
    window.requestAnimationFrame(syncViewportHeight);
  };
  syncAfterLayout();
  window.addEventListener("resize", syncAfterLayout);
  window.visualViewport?.addEventListener("resize", syncAfterLayout);
  // A scroll needs no re-layout, so it reads the height straight away.
  window.visualViewport?.addEventListener("scroll", syncViewportHeight);

  return () => {
    window.removeEventListener("resize", syncAfterLayout);
    window.visualViewport?.removeEventListener("resize", syncAfterLayout);
    window.visualViewport?.removeEventListener("scroll", syncViewportHeight);
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

/**
 * On the unfolded iPhone Duo, iOS 27.2 shrinks a home-screen web app by 82pt (the inner display's
 * portrait status bar) when it comes back from the background, and only a fold cycle restores it.
 * A black-translucent web clip keeps the full size there. Its status bar is a side column on the
 * cover display and the landscape inner display, so the header blur that keeps the style out of
 * index.html elsewhere (#5656) did not show on either. iOS reads the style once, when the user adds
 * the page to the Home Screen. The Duo reports a 466x678 screen on both displays.
 */
export function installIphoneDuoStatusBarStyle(): void {
  const { width, height } = window.screen;
  if (Math.min(width, height) !== 466 || Math.max(width, height) !== 678) return;
  const meta = document.createElement("meta");
  meta.name = "apple-mobile-web-app-status-bar-style";
  meta.content = "black-translucent";
  document.head.appendChild(meta);
}
