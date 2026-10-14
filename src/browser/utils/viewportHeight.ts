import { isIosStandaloneWebApp } from "@/browser/utils/env";

export const APP_VIEWPORT_HEIGHT_PROPERTY = "--app-viewport-height";

function syncViewportHeight(): void {
  document.documentElement.style.setProperty(
    APP_VIEWPORT_HEIGHT_PROPERTY,
    `${window.innerHeight}px`
  );
}

/**
 * Size the app shell from window.innerHeight on iOS home-screen web apps, where iOS 26 can
 * resolve 100dvh as if a browser toolbar were still present and leave a blank band under
 * the footer. Other environments keep the CSS dvh fallback.
 */
export function installViewportHeightSync(): () => void {
  if (!isIosStandaloneWebApp()) {
    return () => undefined;
  }

  syncViewportHeight();
  window.addEventListener("resize", syncViewportHeight);

  return () => {
    window.removeEventListener("resize", syncViewportHeight);
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
  if (!CSS.supports("-webkit-touch-callout", "none")) return;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (meta == null || /maximum-scale/i.test(meta.content)) return;
  meta.content = `${meta.content}, maximum-scale=1`;
}
