import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { useState } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";
import { CUSTOM_EVENTS } from "@/common/constants/events";
import { TooltipProvider } from "../Tooltip/Tooltip";
import { LeftSidebarToggleBar } from "./SidebarCollapseButton";

let cleanupDom: (() => void) | null = null;

function ToggleBar(props: { hasNewChatTarget: boolean }) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <TooltipProvider>
      <LeftSidebarToggleBar
        collapsed={collapsed}
        showNewChat={collapsed && props.hasNewChatTarget}
        onToggle={() => setCollapsed((prev) => !prev)}
      />
    </TooltipProvider>
  );
}

describe("LeftSidebarToggleBar", () => {
  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  // The toggle is one element for both states, so a keyboard user keeps focus on it.
  test("the focused toggle survives collapse and expand", () => {
    const view = render(<ToggleBar hasNewChatTarget />);

    const toggle = view.getByRole("button", { name: "Collapse sidebar" });
    act(() => toggle.focus());
    fireEvent.click(toggle);
    expect(view.getByRole("button", { name: "Open sidebar menu" })).toBe(toggle);
    expect(document.activeElement).toBe(toggle);

    fireEvent.click(toggle);
    expect(view.getByRole("button", { name: "Collapse sidebar" })).toBe(toggle);
    expect(document.activeElement).toBe(toggle);
  });

  test("New chat shows while collapsed and asks the sidebar to start a chat", () => {
    const view = render(<ToggleBar hasNewChatTarget />);
    expect(view.queryByRole("button", { name: "New chat" })).toBeNull();

    fireEvent.click(view.getByRole("button", { name: "Collapse sidebar" }));
    const onNewChat = mock(() => undefined);
    window.addEventListener(CUSTOM_EVENTS.NEW_CHAT_REQUESTED, onNewChat);
    try {
      fireEvent.click(view.getByRole("button", { name: "New chat" }));
    } finally {
      window.removeEventListener(CUSTOM_EVENTS.NEW_CHAT_REQUESTED, onNewChat);
    }
    expect(onNewChat).toHaveBeenCalledTimes(1);
  });
});
