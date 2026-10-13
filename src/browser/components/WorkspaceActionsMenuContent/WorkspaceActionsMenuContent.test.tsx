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
        state={{
          surface: "topbar",
          workspace: {},
          showsSubAgent: false,
          isRuntimeRunning: false,
          isTouchMobileScreen: false,
          isPhoneHeader: false,
          isRightSidebarHidden: false,
        }}
        // Only these rows are wired, so only they render.
        actions={{
          configureMcp: onConfigureMcp,
          configureHeartbeat: onConfigureHeartbeat,
          archive: onArchiveChat,
        }}
        isPinned={false}
        onCloseMenu={() => undefined}
      />
    );
    return { view, onConfigureHeartbeat };
  }

  // Key events go to the focused row and bubble to the menu content, as a real keypress does.
  const press = (key: string) => fireEvent.keyDown(document.activeElement as HTMLElement, { key });

  test("ArrowDown and ArrowUp move focus between the rows and stop at the ends", () => {
    const { view } = renderMenu();
    const rows = [/Configure MCP servers/, /Configure heartbeat/, /Archive workspace/].map((name) =>
      view.getByRole("button", { name })
    );
    // Exactly these rows, in this order.
    expect(view.getAllByRole("button")).toEqual(rows);

    rows[0].focus();
    press("ArrowDown");
    expect(document.activeElement).toBe(rows[1]);
    press("ArrowDown");
    expect(document.activeElement).toBe(rows[2]);
    // Stops at the last row instead of leaving the menu.
    press("ArrowDown");
    expect(document.activeElement).toBe(rows[2]);

    press("ArrowUp");
    expect(document.activeElement).toBe(rows[1]);
    press("ArrowUp");
    press("ArrowUp");
    expect(document.activeElement).toBe(rows[0]);
  });

  test("activating the row reached with the arrow keys runs that row's action", () => {
    const { view, onConfigureHeartbeat } = renderMenu();

    view.getByRole("button", { name: /Configure MCP servers/ }).focus();
    press("ArrowDown");
    // A focused <button> turns Enter into a click on itself.
    fireEvent.click(document.activeElement as HTMLElement);
    expect(onConfigureHeartbeat).toHaveBeenCalledTimes(1);
  });
});

// The menu bar handles the MCP and messages shortcuts for the selected workspace, so only its own
// menu may advertise them. A sidebar row's menu belongs to that row, which need not be selected.
describe("WorkspaceActionsMenuContent shortcut hints per surface (#6202)", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  const common = { workspace: {}, showsSubAgent: false, isRuntimeRunning: false };
  const surfaces = {
    sidebar: { surface: "sidebar", ...common, canMarkUnread: false, canToggleSubAgents: false },
    topbar: {
      surface: "topbar",
      ...common,
      isTouchMobileScreen: false,
      isPhoneHeader: false,
      isRightSidebarHidden: false,
    },
  } as const;

  test.each([
    ["sidebar", false],
    ["topbar", true],
  ] as const)("%s menu shows the selected-workspace shortcut hints: %p", (surface, shown) => {
    const noop = () => undefined;
    const view = render(
      <WorkspaceActionsMenuContent
        state={surfaces[surface]}
        actions={{ configureMcp: noop, configureMessaging: noop, archive: noop }}
        isPinned={false}
        onCloseMenu={noop}
      />
    );
    const hintOf = (testId: string) =>
      view.getByTestId(testId).querySelector(".mobile-hide-shortcut-hints") != null;
    expect(hintOf("workspace-mcp-button")).toBe(shown);
    expect(hintOf("workspace-unrelated-messaging-button")).toBe(shown);
    // Archive acts on its own row's workspace in both menus, so it keeps its hint.
    expect(view.getByRole("button", { name: /Archive workspace/ }).textContent).toContain("(");
  });
});
