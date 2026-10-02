// Bootstrap Happy DOM before anything touches window (see MemoryTab.test.tsx).
import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { installDom } from "../../../../tests/ui/dom";
import { isRightSidebarResponsivelyHidden } from "./rightSidebarVisibility";

describe("isRightSidebarResponsivelyHidden", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanupDom?.();
    cleanupDom = null;
  });

  function sidebar(options: { display: string; ariaHidden?: boolean }): HTMLElement {
    const element = document.createElement("div");
    element.style.display = options.display;
    if (options.ariaHidden) element.setAttribute("aria-hidden", "true");
    document.body.appendChild(element);
    return element;
  }

  test("a display:none sidebar is responsively hidden", () => {
    expect(isRightSidebarResponsivelyHidden(sidebar({ display: "none" }))).toBe(true);
  });

  test("a visible sidebar is not hidden", () => {
    expect(isRightSidebarResponsivelyHidden(sidebar({ display: "flex" }))).toBe(false);
  });

  test("immersive review's aria-hidden hide is not a responsive hide", () => {
    expect(isRightSidebarResponsivelyHidden(sidebar({ display: "none", ariaHidden: true }))).toBe(
      false
    );
  });
});
