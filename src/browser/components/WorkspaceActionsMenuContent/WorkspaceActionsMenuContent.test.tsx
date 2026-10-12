import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";

import { WorkspaceActionsMenuContent } from "./WorkspaceActionsMenuContent";

describe("WorkspaceActionsMenuContent keyboard navigation (#6103)", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  function renderMenu() {
    const onConfigureMcp = mock(() => undefined);
    const onConfigureHeartbeat = mock(() => undefined);
    const onArchiveChat = mock(() => undefined);
    const view = render(
      <WorkspaceActionsMenuContent
        onConfigureMcp={onConfigureMcp}
        onConfigureHeartbeat={onConfigureHeartbeat}
        onArchiveChat={onArchiveChat}
        onCloseMenu={() => undefined}
      />
    );
    return { view, onConfigureHeartbeat };
  }

  test("ArrowDown and ArrowUp move focus between the menu items and stop at the ends", () => {
    const { view } = renderMenu();
    const menu = view.getByRole("menu");
    const items = [/Configure MCP servers/, /Configure heartbeat/, /Archive chat/].map((name) =>
      view.getByRole("menuitem", { name })
    );
    // Exactly these rows, in this order, are the menu's items.
    expect(view.getAllByRole("menuitem")).toEqual(items);

    items[0].focus();
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[2]);
    // Stops at the last item instead of leaving the menu.
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[2]);

    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(document.activeElement).toBe(items[0]);
  });

  test("activating the item reached with the arrow keys runs that item's action", () => {
    const { view, onConfigureHeartbeat } = renderMenu();
    const menu = view.getByRole("menu");
    const items = view.getAllByRole("menuitem");

    items[0].focus();
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    // A focused <button> turns Enter into a click on itself.
    fireEvent.click(document.activeElement as HTMLElement);
    expect(onConfigureHeartbeat).toHaveBeenCalledTimes(1);
  });
});
