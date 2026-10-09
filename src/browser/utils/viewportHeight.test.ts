import "../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { installDom } from "../../../tests/ui/dom";
import { APP_VIEWPORT_HEIGHT_PROPERTY, installViewportHeightSync } from "./viewportHeight";

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

function appViewportHeight(): string {
  return document.documentElement.style.getPropertyValue(APP_VIEWPORT_HEIGHT_PROPERTY);
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
});
