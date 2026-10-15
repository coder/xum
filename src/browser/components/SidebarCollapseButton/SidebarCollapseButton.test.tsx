import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { useState } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";
import { TooltipProvider } from "../Tooltip/Tooltip";
import { CollapsedSidebarHeaderControls, SidebarCollapseButton } from "./SidebarCollapseButton";

let cleanupDom: (() => void) | null = null;

// Like the app: the sidebar's title bar holds the toggle while expanded and the page header holds
// it while collapsed, so every toggle unmounts the button that was pressed.
function ToggleHosts() {
  const [collapsed, setCollapsed] = useState(false);
  const toggle = () => setCollapsed((prev) => !prev);
  return (
    <TooltipProvider>
      {collapsed ? (
        <CollapsedSidebarHeaderControls onToggle={toggle} />
      ) : (
        <SidebarCollapseButton collapsed={false} onToggle={toggle} />
      )}
    </TooltipProvider>
  );
}

describe("SidebarCollapseButton", () => {
  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("keyboard activation hands focus to the toggle in the other host", () => {
    const view = render(<ToggleHosts />);

    const collapse = view.getByRole("button", { name: "Collapse sidebar" });
    act(() => collapse.focus());
    // Enter or Space on a focused button dispatches a click with detail 0.
    fireEvent.click(collapse, { detail: 0 });
    const open = view.getByRole("button", { name: "Open sidebar menu" });
    expect(document.activeElement).toBe(open);

    fireEvent.click(open, { detail: 0 });
    expect(document.activeElement).toBe(view.getByRole("button", { name: "Collapse sidebar" }));
  });

  // Focus would open the new button's tooltip under the pointer.
  test("a pointer click does not move focus to the other toggle", () => {
    const view = render(<ToggleHosts />);

    const collapse = view.getByRole("button", { name: "Collapse sidebar" });
    act(() => collapse.focus());
    fireEvent.click(collapse, { detail: 1 });
    expect(document.activeElement).not.toBe(
      view.getByRole("button", { name: "Open sidebar menu" })
    );
  });
});
