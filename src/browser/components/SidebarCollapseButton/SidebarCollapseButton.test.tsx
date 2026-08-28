import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";
import { CUSTOM_EVENTS } from "@/common/constants/events";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { SidebarCollapseButton } from "./SidebarCollapseButton";

let cleanupDom: (() => void) | null = null;

describe("SidebarCollapseButton", () => {
  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  it("requests main-region focus after collapsing", () => {
    const onToggle = mock(() => undefined);
    let focusRequests = 0;
    window.addEventListener(CUSTOM_EVENTS.FOCUS_MAIN_REGION, () => {
      focusRequests += 1;
    });
    globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    };

    const view = render(
      <TooltipProvider>
        <SidebarCollapseButton collapsed={false} onToggle={onToggle} side="right" />
      </TooltipProvider>
    );

    fireEvent.click(view.getByRole("button", { name: "Collapse sidebar" }));

    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(focusRequests).toBe(1);
  });

  it("does not request main-region focus after expanding", () => {
    const onToggle = mock(() => undefined);
    let focusRequests = 0;
    window.addEventListener(CUSTOM_EVENTS.FOCUS_MAIN_REGION, () => {
      focusRequests += 1;
    });
    globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    };

    const view = render(
      <TooltipProvider>
        <SidebarCollapseButton collapsed onToggle={onToggle} side="right" />
      </TooltipProvider>
    );

    fireEvent.click(view.getByRole("button", { name: "Expand sidebar" }));

    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(focusRequests).toBe(0);
  });
});
