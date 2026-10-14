import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";

import { KEYBINDS, type Keybind } from "@/browser/utils/ui/keybinds";
import {
  WorkspaceActionsMenuContent,
  type WorkspaceActionHandlers,
} from "./WorkspaceActionsMenuContent";
import type { WorkspaceActionId, WorkspaceActionsState } from "./workspaceActionItems";

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

// The global handlers act on the SELECTED workspace, and a sidebar row's menu is often another
// workspace's. While a menu is open, every key its rows hint must act on that menu's workspace
// and must not reach the global handlers (#6328).
describe("WorkspaceActionsMenuContent row shortcut keys (#6328)", () => {
  let cleanupDom: (() => void) | null = null;
  let windowKeys: string[] = [];
  const recordWindowKey = (event: KeyboardEvent) => windowKeys.push(event.code || event.key);

  beforeEach(() => {
    cleanupDom = installDom();
    windowKeys = [];
    window.addEventListener("keydown", recordWindowKey);
  });

  afterEach(() => {
    window.removeEventListener("keydown", recordWindowKey);
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  // A read, unselected sidebar row with completed sub-agents and a running devcontainer:
  // every sidebar row shows.
  const sidebarState: WorkspaceActionsState = {
    surface: "sidebar",
    workspace: {},
    showsSubAgent: false,
    isRuntimeRunning: true,
    canMarkUnread: true,
    canToggleSubAgents: true,
  };

  function renderSidebarMenu(actions: WorkspaceActionHandlers, state = sidebarState) {
    const onCloseMenu = mock(() => undefined);
    const view = render(
      <WorkspaceActionsMenuContent
        state={state}
        actions={actions}
        isPinned={false}
        onCloseMenu={onCloseMenu}
      />
    );
    // The popover focuses its first row when it opens.
    view.getAllByRole("button")[0].focus();
    return { view, onCloseMenu };
  }

  const allActions = (): Record<WorkspaceActionId, ReturnType<typeof mock>> =>
    Object.fromEntries(
      (
        [
          "editTitle",
          "generateTitle",
          "configureMcp",
          "configureHeartbeat",
          "configureMessaging",
          "togglePinned",
          "markUnread",
          "toggleSubAgents",
          "fork",
          "stopRuntime",
          "archive",
        ] as const
      ).map((id) => [id, mock((_anchor: HTMLElement) => undefined)])
    ) as Record<WorkspaceActionId, ReturnType<typeof mock>>;

  // Reads each shown row's hint, presses exactly that key, and checks that the row ran.
  test("every hinted key runs its own row's action and stays in the menu", () => {
    const actions = allActions();
    const { view } = renderSidebarMenu(actions);
    const rows = view.getAllByRole("button");
    const hinted = rows.filter((row) => row.querySelector(".mobile-hide-shortcut-hints"));
    // All sidebar rows carry a hint, the four keys of #6328 included.
    expect(hinted).toHaveLength(rows.length);

    for (const row of hinted) {
      const id = row.getAttribute("data-workspace-action-row") as WorkspaceActionId;
      const keybind = KEYBIND_BY_ROW[id];
      pressKey(toKeyEvent(keybind));
      expect(actions[id]).toHaveBeenCalledTimes(1);
      // Anchored at the row, so an error popover opens next to it.
      expect(actions[id].mock.calls[0]?.[0]).toBe(row);
    }
    expect(windowKeys).toEqual([]);
  });

  test("a row key whose row this menu hides reaches neither the row nor the global handlers", () => {
    const actions = allActions();
    // A nested sub-agent row: no Archive or Pin row.
    renderSidebarMenu(actions, {
      ...sidebarState,
      workspace: { parentWorkspaceId: "parent" },
      showsSubAgent: true,
    });
    pressKey(toKeyEvent(KEYBINDS.ARCHIVE_WORKSPACE));
    pressKey(toKeyEvent(KEYBINDS.PIN_WORKSPACE));
    expect(actions.archive).not.toHaveBeenCalled();
    expect(actions.togglePinned).not.toHaveBeenCalled();
    expect(windowKeys).toEqual([]);
  });

  test("a held row key runs its row once", () => {
    const actions = allActions();
    renderSidebarMenu(actions);
    pressKey(toKeyEvent(KEYBINDS.FORK_WORKSPACE));
    pressKey({ ...toKeyEvent(KEYBINDS.FORK_WORKSPACE), repeat: true });
    expect(actions.fork).toHaveBeenCalledTimes(1);
    expect(windowKeys).toEqual([]);
  });

  // Codex on #6398: the key closes the menu, so its repeats land outside the menu, where the
  // global handlers act on the selected workspace.
  test("a held row key's repeats after the menu closes reach no global handler", () => {
    const actions = allActions();
    const { view } = renderSidebarMenu(actions);
    pressKey(toKeyEvent(KEYBINDS.ARCHIVE_WORKSPACE));
    expect(actions.archive).toHaveBeenCalledTimes(1);
    view.unmount();

    const fire = (type: "keydown" | "keyup", init: KeyboardEventInit) => {
      const event = new window.KeyboardEvent(type, { ...init, bubbles: true, cancelable: true });
      Object.defineProperty(event, "getModifierState", { value: () => false });
      document.body.dispatchEvent(event);
    };
    const archive = toKeyEvent(KEYBINDS.ARCHIVE_WORKSPACE);
    fire("keydown", { ...archive, repeat: true });
    fire("keydown", { ...archive, repeat: true });
    expect(windowKeys).toEqual([]);

    // Released: the next press is a new one and reaches the global handlers again.
    fire("keyup", archive);
    fire("keydown", archive);
    expect(windowKeys).toEqual(["Backspace"]);
  });

  // #6434: a click on the menu's padding or a separator focuses the popover itself, outside the
  // rows. The key must still act on this menu's workspace, not reach the global handlers.
  test("a hinted key acts on the menu while focus is on the popover around the rows", () => {
    const actions = allActions();
    const popover = document.createElement("div");
    popover.setAttribute("role", "dialog");
    popover.tabIndex = -1;
    document.body.appendChild(popover);
    const onCloseMenu = mock(() => undefined);
    render(
      <WorkspaceActionsMenuContent
        state={sidebarState}
        actions={actions}
        isPinned={false}
        onCloseMenu={onCloseMenu}
      />,
      { container: popover }
    );
    popover.focus();

    pressKey(toKeyEvent(KEYBINDS.EDIT_WORKSPACE_TITLE));
    expect(actions.editTitle).toHaveBeenCalledTimes(1);
    expect(onCloseMenu).toHaveBeenCalledTimes(1);
    expect(windowKeys).toEqual([]);
  });

  // Coordinator scoping rule (#6434): keys from outside the menu's popover keep their global meaning.
  test("a hinted key from outside the menu's popover stays with the global handlers", () => {
    const actions = allActions();
    renderSidebarMenu(actions);
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();

    pressKey(toKeyEvent(KEYBINDS.EDIT_WORKSPACE_TITLE));
    expect(actions.editTitle).not.toHaveBeenCalled();
    expect(windowKeys).toEqual(["F2"]);
  });

  test("other keys still reach the global handlers", () => {
    renderSidebarMenu(allActions());
    pressKey(toKeyEvent(KEYBINDS.NEXT_WORKSPACE));
    expect(windowKeys).toEqual(["KeyJ"]);
  });
});

// The keybind a row hints, keyed by its test-visible id. Each assertion presses the hinted key.
const KEYBIND_BY_ROW: Partial<Record<WorkspaceActionId, Keybind>> = {
  editTitle: KEYBINDS.EDIT_WORKSPACE_TITLE,
  generateTitle: KEYBINDS.GENERATE_WORKSPACE_TITLE,
  configureMcp: KEYBINDS.CONFIGURE_MCP,
  configureHeartbeat: KEYBINDS.CONFIGURE_HEARTBEAT,
  configureMessaging: KEYBINDS.CONFIGURE_UNRELATED_MESSAGING,
  togglePinned: KEYBINDS.PIN_WORKSPACE,
  markUnread: KEYBINDS.MARK_WORKSPACE_UNREAD,
  toggleSubAgents: KEYBINDS.TOGGLE_COMPLETED_SUB_AGENTS,
  fork: KEYBINDS.FORK_WORKSPACE,
  stopRuntime: KEYBINDS.STOP_WORKSPACE_RUNTIME,
  archive: KEYBINDS.ARCHIVE_WORKSPACE,
};

// Presses a key on the focused row, as a real keypress does.
function pressKey(init: KeyboardEventInit) {
  const event = new window.KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true });
  // happy-dom infers AltGraph from any Ctrl+Alt chord; model physical Ctrl+Alt here.
  Object.defineProperty(event, "getModifierState", { value: () => false });
  fireEvent(document.activeElement as HTMLElement, event);
}

function toKeyEvent(keybind: Keybind | undefined): KeyboardEventInit {
  if (!keybind) throw new Error("row has a hint but no keybind in KEYBIND_BY_ROW");
  const letter = keybind.key.length === 1 ? keybind.key.toUpperCase() : null;
  return {
    key: keybind.key,
    code: keybind.code ?? (letter ? `Key${letter}` : keybind.key),
    ctrlKey: keybind.ctrl === true,
    shiftKey: keybind.shift === true,
    altKey: keybind.alt === true,
    metaKey: false,
  };
}
