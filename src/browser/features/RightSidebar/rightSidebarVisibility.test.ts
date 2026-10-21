// Bootstrap Happy DOM before anything touches window (see MemoryTab.test.tsx).
import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { installDom } from "../../../../tests/ui/dom";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { getReviewImmersiveKey } from "@/common/constants/storage";
import { canToggleRightSidebar, isRightSidebarResponsivelyHidden } from "./rightSidebarVisibility";

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

describe("canToggleRightSidebar", () => {
  let cleanupDom: (() => void) | null = null;
  const workspaceId = "ws-toggle";

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    updatePersistedState(getReviewImmersiveKey(workspaceId), null);
    cleanupDom?.();
    cleanupDom = null;
  });

  // A workspace shell holding a visible docked sidebar, plus an optional marker inside it.
  function shell(marker?: "fullscreen" | "load-failed"): HTMLElement {
    const root = document.createElement("div");
    const sidebar = document.createElement("div");
    sidebar.className = "mobile-hide-right-sidebar";
    sidebar.style.display = "flex";
    if (marker === "fullscreen") sidebar.classList.add("right-sidebar-fullscreen");
    if (marker === "load-failed") sidebar.setAttribute("data-right-sidebar-load-failed", "true");
    root.appendChild(sidebar);
    document.body.appendChild(root);
    return root;
  }

  test("a docked, visible sidebar can toggle", () => {
    expect(canToggleRightSidebar(workspaceId, shell())).toBe(true);
  });

  test("the phone full-screen view and a failed load refuse the toggle", () => {
    expect(canToggleRightSidebar(workspaceId, shell("fullscreen"))).toBe(false);
    expect(canToggleRightSidebar(workspaceId, shell("load-failed"))).toBe(false);
  });

  test("a sidebar the narrow layout hides refuses the toggle", () => {
    const root = shell();
    root.querySelector<HTMLElement>(".mobile-hide-right-sidebar")!.style.display = "none";
    expect(canToggleRightSidebar(workspaceId, root)).toBe(false);
  });

  test("immersive review refuses the toggle", () => {
    updatePersistedState(getReviewImmersiveKey(workspaceId), true);
    expect(canToggleRightSidebar(workspaceId, shell())).toBe(false);
  });
});
