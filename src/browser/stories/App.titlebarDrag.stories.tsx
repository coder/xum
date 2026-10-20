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
 * drags while the bar's buttons do not.
 */

import { expect, within } from "storybook/test";

import { appMeta, AppWithMocks, PIXEL_DISABLED, type AppStory } from "./meta.js";
import { setupSimpleChatStory } from "./helpers/chatSetup";
import { collapseLeftSidebar, expandLeftSidebar } from "./helpers/uiState";
import { windowDragsAt, withDesktopApi } from "./helpers/windowDrag";
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

// isDesktopMode() keys on getIsRosetta; the default darwin platform gives the macOS title bar.
const desktopStory = (story: Pick<AppStory, "render" | "play">): AppStory => ({
  ...story,
  parameters: { ...appMeta.parameters, pixel: PIXEL_DISABLED },
  beforeEach: withDesktopApi({ isRosetta: false, getIsRosetta: () => Promise.resolve(false) }),
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
  },
});
