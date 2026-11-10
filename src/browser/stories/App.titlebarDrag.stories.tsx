/**
 * Desktop window dragging from the top bar. Electron moves the window where the last app-region
 * rect in DOM order under the pointer is drag (see `windowDragsAt`), so empty stretches of the
 * headers must drag while every control under them, including the app shell's fixed sidebar
 * toggle bar, stays clickable.
 *
 * WorkspaceExpanded: the gap between the workspace title and the header's actions drags, and so
 * does the gap between the version text and the sidebar title bar's buttons (macOS layout).
 *
 * WorkspaceCollapsed: the page header spans the window under the toggle bar, and its gap still
 * drags while the bar's buttons do not. The header's title edit field (F2) stays clickable.
 *
 * RightSidebarToggle: the right sidebar's toggle stays clickable over the sidebar's tab strip
 * (expanded) and over the workspace header (collapsed).
 */

import { expect, userEvent, waitFor, within } from "storybook/test";

import { appMeta, AppWithMocks, PIXEL_DISABLED, type AppStory } from "./meta.js";
import { setupSimpleChatStory } from "./helpers/chatSetup";
import { collapseLeftSidebar, expandLeftSidebar, expandRightSidebar } from "./helpers/uiState";
import { windowDragsAt, windowDragsAtEach, withDesktopTitlebar } from "./helpers/windowDrag";
import { createAssistantMessage, createUserMessage } from "./mocks/messages";
import { STABLE_TIMESTAMP } from "./mocks/workspaces";

export default {
  ...appMeta,
  title: "App/TitlebarDrag",
};

const setupWorkspace = () =>
  setupSimpleChatStory({
    workspaceId: "ws-titlebar-drag",
    workspaceName: "titlebar-drag",
    messages: [
      createUserMessage("msg-1", "Move the window", {
        historySequence: 1,
        timestamp: STABLE_TIMESTAMP - 60000,
      }),
      createAssistantMessage("msg-2", "Drag the top bar.", {
        historySequence: 2,
        timestamp: STABLE_TIMESTAMP - 50000,
      }),
    ],
  });

const center = (element: Element) => {
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
};

async function expectDrags(element: Element, label: string, drags: boolean) {
  const point = center(element);
  await expect(windowDragsAt(point.x, point.y), `${label} drags the window`).toBe(drags);
}

/** The empty stretch between the Info button and the first action of the workspace header. */
async function expectWorkspaceHeaderGapDrags(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const header = await canvas.findByTestId("workspace-menu-bar", {}, { timeout: 15_000 });
  const info = await within(header).findByRole("button", { name: "Workspace details" });
  const bell = await within(header).findByTestId("notify-on-response-button");
  const actions = bell.parentElement;
  if (!actions) throw new Error("workspace header actions group not found");
  const headerRect = header.getBoundingClientRect();
  const gapLeft = info.getBoundingClientRect().right;
  const gapRight = actions.getBoundingClientRect().left;
  await expect(gapRight - gapLeft).toBeGreaterThan(0);
  const y = headerRect.top + headerRect.height / 2;
  await expect(windowDragsAt((gapLeft + gapRight) / 2, y), "workspace header gap drags").toBe(true);
  await expectDrags(info, "Workspace details button", false);
  await expectDrags(bell, "Notifications button", false);
}

/**
 * Where in the element's box the window drags: its center and its corners (1px in). A no-drag
 * hole smaller than the control, or off its place, still covers the center.
 */
function draggingPoints(element: Element): string[] {
  const rect = element.getBoundingClientRect();
  const points = {
    center: center(element),
    "top left": { x: rect.left + 1, y: rect.top + 1 },
    "top right": { x: rect.right - 1, y: rect.top + 1 },
    "bottom left": { x: rect.left + 1, y: rect.bottom - 1 },
    "bottom right": { x: rect.right - 1, y: rect.bottom - 1 },
  };
  const drags = windowDragsAtEach(Object.values(points));
  return Object.keys(points).filter((_, index) => drags[index]);
}

/** On every animation frame while `act` runs: does the window drag anywhere on the element? */
async function sampleDragFrames(element: Element, act: () => Promise<void>) {
  const result = { frames: 0, dragging: 0 };
  let sampling = true;
  const sample = () => {
    if (!sampling) return;
    result.frames++;
    if (draggingPoints(element).length > 0) result.dragging++;
    requestAnimationFrame(sample);
  };
  sample();
  try {
    await act();
  } finally {
    sampling = false;
  }
  return result;
}

const desktopStory = (story: Pick<AppStory, "render" | "play">): AppStory => ({
  ...story,
  parameters: { ...appMeta.parameters, pixel: PIXEL_DISABLED },
  beforeEach: withDesktopTitlebar,
});

export const WorkspaceExpanded = desktopStory({
  render: () => (
    <AppWithMocks
      setup={() => {
        expandLeftSidebar();
        return setupWorkspace();
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expectWorkspaceHeaderGapDrags(canvasElement);

    const versionButton = await canvas.findByRole("button", { name: "Open about dialog" });
    const version = versionButton.querySelector<HTMLElement>("div.truncate");
    if (!version) throw new Error("version text not found in the title bar");
    const controls = (await canvas.findByTestId("analytics-button")).parentElement;
    if (!controls) throw new Error("title bar controls not found");
    // The text's own extent: the version box itself may be wider than its text.
    const range = document.createRange();
    range.selectNodeContents(version);
    const textRect = range.getBoundingClientRect();
    const gapRight = controls.getBoundingClientRect().left;
    await expect(gapRight - textRect.right, "title bar gap width").toBeGreaterThanOrEqual(32);
    const titleBarRect = versionButton.parentElement?.getBoundingClientRect();
    if (!titleBarRect) throw new Error("title bar version wrapper not found");
    const y = titleBarRect.top + titleBarRect.height / 2;
    await expect(windowDragsAt((textRect.right + gapRight) / 2, y), "title bar gap drags").toBe(
      true
    );
    await expectDrags(version, "version text", false);

    await expectDrags(
      await within(await canvas.findByTestId("left-sidebar-toggle-bar")).findByRole("button", {
        name: "Collapse sidebar",
      }),
      "Collapse sidebar button",
      false
    );
  },
});

export const WorkspaceCollapsed = desktopStory({
  render: () => (
    <AppWithMocks
      setup={() => {
        // Collapsed before the app renders, so no hover or focus leaves a tooltip on screen.
        collapseLeftSidebar();
        return setupWorkspace();
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const bar = within(
      await within(canvasElement).findByTestId("left-sidebar-toggle-bar", {}, { timeout: 15_000 })
    );
    await expectDrags(
      await bar.findByRole("button", { name: "Open sidebar menu" }),
      "Open sidebar menu button",
      false
    );
    await expectDrags(await bar.findByRole("button", { name: "New chat" }), "New chat", false);
    await expectWorkspaceHeaderGapDrags(canvasElement);

    // F2 edits the title in the header while the sidebar hides the workspace row; a focused
    // chat input would keep the key.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    await userEvent.keyboard("{F2}");
    await expectDrags(
      await within(canvasElement).findByRole("textbox", { name: "Edit workspace title" }),
      "Title edit field",
      false
    );
  },
});

export const RightSidebarToggle = desktopStory({
  render: () => (
    <AppWithMocks
      setup={() => {
        const client = setupWorkspace();
        expandRightSidebar("ws-titlebar-drag");
        return client;
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const toggle = await canvas.findByRole(
      "button",
      { name: "Collapse right sidebar" },
      { timeout: 15_000 }
    );
    const strip = () => canvas.queryByRole("tablist", { name: "Sidebar views" });
    // The toggle renders before the lazy sidebar: wait for the strip that comes after it.
    await waitFor(() => expect(strip()).toBeInTheDocument(), { timeout: 15_000 });
    await expect(draggingPoints(toggle), "Collapse right sidebar button drags at").toEqual([]);

    // The strip slides under the toggle while the sidebar's width animates.
    const collapsing = await sampleDragFrames(toggle, async () => {
      await userEvent.click(toggle);
      await waitFor(() => expect(strip()).not.toBeInTheDocument());
    });
    await expect(collapsing.frames).toBeGreaterThan(2);
    await expect(collapsing.dragging, "frames the toggle drags in while collapsing").toBe(0);
    await expect(toggle).toHaveAccessibleName("Expand right sidebar");
    await expect(draggingPoints(toggle), "Expand right sidebar button drags at").toEqual([]);
    await expectWorkspaceHeaderGapDrags(canvasElement);

    const expanding = await sampleDragFrames(toggle, async () => {
      await userEvent.click(toggle);
      await waitFor(() => {
        const sidebar = canvas.getByRole("complementary", { name: "Workspace insights" });
        if (strip() == null || sidebar.getAnimations().length > 0) {
          throw new Error("The sidebar is still sliding open");
        }
      });
    });
    await expect(expanding.frames).toBeGreaterThan(2);
    await expect(expanding.dragging, "frames the toggle drags in while expanding").toBe(0);
  },
});
