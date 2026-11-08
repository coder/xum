import "../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { installDom } from "../../../tests/ui/dom";
import {
  APP_VIEWPORT_HEIGHT_PROPERTY,
  installIosFocusZoomGuard,
  installIphoneDuoStatusBarStyle,
  installViewportHeightSync,
} from "./viewportHeight";

function setStandalone(value: boolean | undefined) {
  Object.defineProperty(globalThis.navigator, "standalone", {
    configurable: true,
    get: () => value,
  });
}

function setInnerHeight(value: number) {
  Object.defineProperty(globalThis.window, "innerHeight", {
    configurable: true,
    get: () => value,
  });
}

/** A stand-in visual viewport; iOS resizes it, and not the window, for the software keyboard. */
function installVisualViewport(height: number, scale = 1) {
  const viewport = Object.assign(new window.EventTarget(), { height, scale });
  Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  return viewport;
}

function appViewportHeight(): string {
  return document.documentElement.style.getPropertyValue(APP_VIEWPORT_HEIGHT_PROPERTY);
}

/** Runs requestAnimationFrame callbacks inline, so a test can flush them when it chooses. */
function withFrames(run: (drain: () => void) => void) {
  const frames: FrameRequestCallback[] = [];
  const original = window.requestAnimationFrame;
  Object.defineProperty(window, "requestAnimationFrame", {
    configurable: true,
    value: (callback: FrameRequestCallback) => frames.push(callback),
  });
  try {
    run(() => {
      for (const frame of frames.splice(0)) frame(0);
    });
  } finally {
    Object.defineProperty(window, "requestAnimationFrame", { configurable: true, value: original });
  }
}

describe("iOS standalone viewport", () => {
  let cleanupDom: (() => void) | null = null;
  let cleanupSync: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanupSync?.();
    cleanupSync = null;
    cleanupDom?.();
    cleanupDom = null;
  });

  test("uses the native status-bar layout for new installs", async () => {
    const html = await readFile(path.join(process.cwd(), "index.html"), "utf8");
    const page = new window.DOMParser().parseFromString(html, "text/html");
    const statusBarStyle = page
      .querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')
      ?.getAttribute("content");

    expect(statusBarStyle ?? "default").toBe("default");
  });

  // WCAG 1.4.4 (#5972): users must be able to pinch-zoom the app. Lighthouse's meta-viewport audit
  // fails `user-scalable=no` and any `maximum-scale` below 5.
  test("lets users zoom the page", async () => {
    const html = await readFile(path.join(process.cwd(), "index.html"), "utf8");
    const page = new window.DOMParser().parseFromString(html, "text/html");
    const content = page.querySelector('meta[name="viewport"]')?.getAttribute("content");
    if (content == null) throw new Error("index.html has no viewport meta");

    const tokens = new Map(
      content.split(",").map((token) => {
        const [key, value = ""] = token.split("=").map((part) => part.trim().toLowerCase());
        return [key, value] as const;
      })
    );
    const userScalable = tokens.get("user-scalable");
    expect(userScalable === "no" || userScalable === "0").toBe(false);
    const maximumScale = tokens.get("maximum-scale");
    if (maximumScale !== undefined) expect(Number(maximumScale)).toBeGreaterThanOrEqual(5);
  });

  test("leaves the CSS dvh fallback in place outside iOS standalone", () => {
    setStandalone(undefined);
    setInnerHeight(700);

    cleanupSync = installViewportHeightSync();
    window.dispatchEvent(new window.Event("resize"));

    expect(appViewportHeight()).toBe("");
  });

  test("tracks innerHeight on iOS standalone and clears it on cleanup", () => {
    setStandalone(true);
    setInnerHeight(852);

    cleanupSync = installViewportHeightSync();
    expect(appViewportHeight()).toBe("852px");

    setInnerHeight(500);
    window.dispatchEvent(new window.Event("resize"));
    expect(appViewportHeight()).toBe("500px");

    cleanupSync();
    cleanupSync = null;
    expect(appViewportHeight()).toBe("");

    setInnerHeight(852);
    window.dispatchEvent(new window.Event("resize"));
    expect(appViewportHeight()).toBe("");
  });

  test("follows the keyboard, which resizes only the visual viewport", () => {
    setStandalone(true);
    setInnerHeight(657);
    const viewport = installVisualViewport(657);
    cleanupSync = installViewportHeightSync();

    viewport.height = 324;
    viewport.dispatchEvent(new window.Event("resize"));
    expect(appViewportHeight()).toBe("324px");

    viewport.height = 657;
    viewport.dispatchEvent(new window.Event("resize"));
    expect(appViewportHeight()).toBe("657px");
  });

  test("keeps the full height while pinch zoomed in", () => {
    setStandalone(true);
    setInnerHeight(657);
    const viewport = installVisualViewport(657);
    cleanupSync = installViewportHeightSync();

    viewport.height = 328.5;
    viewport.scale = 2;
    viewport.dispatchEvent(new window.Event("resize"));

    expect(appViewportHeight()).toBe("657px");
  });

  test("undoes the window scroll iOS adds for the keyboard, but not a zoomed-in pan", () => {
    setStandalone(true);
    setInnerHeight(657);
    const viewport = installVisualViewport(657);
    const scrollTo = spyOn(window, "scrollTo").mockImplementation(() => undefined);
    Object.defineProperty(window, "scrollY", { configurable: true, get: () => 333 });
    try {
      cleanupSync = installViewportHeightSync();
      expect(scrollTo).toHaveBeenLastCalledWith(0, 0);

      scrollTo.mockClear();
      viewport.scale = 2;
      viewport.dispatchEvent(new window.Event("scroll"));
      expect(scrollTo).not.toHaveBeenCalled();
    } finally {
      scrollTo.mockRestore();
    }
  });

  test("re-reads the height on the next frame, when a rotation reported a stale one", () => {
    withFrames((drain) => {
      setStandalone(true);
      setInnerHeight(820);
      cleanupSync = installViewportHeightSync();
      expect(appViewportHeight()).toBe("820px");
      drain();

      // iPad landscape to portrait: the resize event still sees the landscape height.
      window.dispatchEvent(new window.Event("resize"));
      setInnerHeight(1180);
      drain();

      expect(appViewportHeight()).toBe("1180px");
    });
  });
});

describe("iOS focus-zoom guard", () => {
  let cleanupDom: (() => void) | null = null;
  const originalCss = globalThis.CSS;

  /** Mirrors index.html's viewport meta and reports whether iOS's touch-callout probe passes. */
  async function setup(isIosWebKit: boolean): Promise<HTMLMetaElement> {
    const html = await readFile(path.join(process.cwd(), "index.html"), "utf8");
    const source = new window.DOMParser().parseFromString(html, "text/html");
    const content = source.querySelector('meta[name="viewport"]')?.getAttribute("content");
    if (content == null) throw new Error("index.html has no viewport meta");

    const meta = document.createElement("meta");
    meta.name = "viewport";
    meta.content = content;
    document.head.appendChild(meta);
    globalThis.CSS = {
      supports: (property: string, value?: string) =>
        isIosWebKit && property === "-webkit-touch-callout" && value === "none",
    } as unknown as typeof CSS;
    return meta;
  }

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    globalThis.CSS = originalCss;
    cleanupDom?.();
    cleanupDom = null;
  });

  test("adds maximum-scale=1 once on iOS WebKit", async () => {
    const meta = await setup(true);
    const original = meta.content;

    installIosFocusZoomGuard();
    installIosFocusZoomGuard();

    expect(meta.content).toBe(`${original}, maximum-scale=1`);
  });

  test("leaves the viewport zoomable elsewhere", async () => {
    const meta = await setup(false);
    const original = meta.content;

    installIosFocusZoomGuard();

    expect(meta.content).toBe(original);
  });
});

describe("iPhone Duo status-bar style", () => {
  let cleanupDom: (() => void) | null = null;

  function statusBarStyle(width: number, height: number): string | null | undefined {
    Object.defineProperty(window.screen, "width", { configurable: true, get: () => width });
    Object.defineProperty(window.screen, "height", { configurable: true, get: () => height });
    installIphoneDuoStatusBarStyle();
    return document
      .querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')
      ?.getAttribute("content");
  }

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanupDom?.();
    cleanupDom = null;
  });

  test("goes black-translucent on the Duo, which reports one screen size on both displays", () => {
    expect(statusBarStyle(466, 678)).toBe("black-translucent");
  });

  test("leaves other screens on the native status-bar layout, even one that shares a side", () => {
    for (const [width, height] of [
      [402, 874],
      [466, 874],
      [402, 678],
    ]) {
      expect(statusBarStyle(width, height)).toBeUndefined();
    }
  });
});
