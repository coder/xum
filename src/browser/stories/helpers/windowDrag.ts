// Shared by story plays that guard which parts of the desktop title bar move the window.

/** Elements that get a layout box even with computed `display: inline`. */
const REPLACED_ELEMENTS = new Set([
  "svg",
  "img",
  "input",
  "textarea",
  "select",
  "video",
  "canvas",
  "iframe",
]);

const APP_REGION_SELECTOR = ".titlebar-drag, .titlebar-no-drag";

export function rectContains(rect: DOMRect, x: number, y: number): boolean {
  return x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom;
}

/**
 * Whether Electron would drag the window from this viewport point. `document.elementFromPoint`
 * cannot tell: z-index and paint order do not count.
 *
 * Chromium (`LocalFrameView::CollectDraggableRegions`) reports the border box of every element
 * box with an `app-region`, in DOM pre-order, skipping boxes that are not `visibility: visible`
 * and objects that are not boxes (inline spans, text, SVG shapes). Since Electron 44 `app-region`
 * inherits, so each descendant box reports its own rect. An explicit `app-region: none` still
 * reports a no-drag rect, so only a box with no region set on it or any ancestor reports nothing.
 * Electron (`shell/browser/ui/drag_util.cc`) then lets the later rect win where rects overlap.
 * The app sets `app-region` only through the `titlebar-drag` and `titlebar-no-drag` classes, so
 * this reads the classes, not the property, and does not depend on the Storybook browser's
 * Chromium version.
 */
export function windowDragsAt(x: number, y: number): boolean {
  let drags = false;
  const visit = (element: Element) => {
    const style = getComputedStyle(element);
    if (style.display === "none") return;
    if (style.display !== "contents") {
      const mode = element.closest(APP_REGION_SELECTOR);
      const isBox = style.display !== "inline" || REPLACED_ELEMENTS.has(element.localName);
      if (mode && isBox && style.visibility === "visible") {
        if (rectContains(element.getBoundingClientRect(), x, y)) {
          drags = mode.classList.contains("titlebar-drag");
        }
      }
    }
    for (const child of element.children) visit(child);
  };
  visit(document.documentElement);
  return drags;
}

/**
 * Electron's preload bridge, as `isDesktopMode()` and the platform banners read it. A
 * `beforeEach` that returns the restore function.
 */
export const withDesktopApi = (api: Partial<NonNullable<typeof window.api>>) => () => {
  const previousApi = window.api;
  window.api = { platform: "darwin", versions: {}, ...previousApi, ...api };
  return () => {
    window.api = previousApi;
  };
};

// isDesktopMode() keys on getIsRosetta; the default darwin platform gives the macOS title bar.
export const withDesktopTitlebar = withDesktopApi({
  isRosetta: false,
  getIsRosetta: () => Promise.resolve(false),
});
