/**
 * Phones: the narrow layout hides the right sidebar, so the workspace menu's Sidebar row shows
 * the sidebar itself full-screen. Its own New tab launcher lists the tools.
 *
 * The stories pin a 390px frame instead of relying on the viewport, so the shell's container query
 * hides the sidebar at any window size (the Storybook test-runner plays at desktop size).
 * FullScreenFromWorkspaceMenu holds the behavior checks and is play-only. FullScreenSidebarOnPhone
 * is the Pixel capture of the open view at the phone viewport.
 */
import { wrapAsyncIterator } from "@orpc/shared";
import { expect, userEvent, waitFor, within } from "@storybook/test";
import type { ComponentType } from "react";

import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import type { RightSidebarLayoutState } from "@/browser/utils/rightSidebarLayout";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import {
  LEFT_SIDEBAR_COLLAPSED_KEY,
  RIGHT_SIDEBAR_COLLAPSED_KEY,
  getRightSidebarLayoutKey,
} from "@/common/constants/storage";
import type { WorkflowRunRecord, WorkflowRunStreamEvent } from "@/common/types/workflow";
import { createAsyncMessageQueue } from "@/common/utils/asyncMessageQueue";

import { setupSimpleChatStory } from "./helpers/chatSetup";
import { appMeta, AppWithMocks, PIXEL_DISABLED, type AppStory } from "./meta.js";
import { createAssistantMessage, createUserMessage } from "./mocks/messages";
import { waitForChatInputAutofocusDone } from "./storyPlayHelpers.js";

export default {
  ...appMeta,
  title: "App/PhoneSidebarFullscreen",
};

const WORKSPACE_ID = "ws-phone-sidebar-fullscreen";
const AT = "2026-05-29T12:00:02.000Z";
const RUN_NAME = "implement-flow";

const RUN: WorkflowRunRecord = {
  id: "wfr_phone_sidebar_fullscreen",
  workspaceId: WORKSPACE_ID,
  workflow: {
    name: RUN_NAME,
    description: "Implement, review, and ship a change",
    scope: "project",
    sourceKind: "inline",
    executable: true,
  },
  source: "export default function workflow() { return null; }",
  sourceHash: "sha256:phone-sidebar-fullscreen",
  args: { contract: "Make right-sidebar tools reachable on phones." },
  status: "running",
  createdAt: AT,
  updatedAt: AT,
  events: [{ sequence: 1, type: "status", at: AT, status: "running" }],
  steps: [],
};

// A workflow run opens its own tab, so the strip holds only Workflows: the Browser tool is not
// open yet and is reachable through the sidebar's New tab launcher.
const LAYOUT: RightSidebarLayoutState = {
  version: 1,
  nextId: 2,
  focusedTabsetId: "tabset-1",
  openTabsOnly: true,
  root: { type: "tabset", id: "tabset-1", tabs: ["workflows"], activeTab: "workflows" },
};

function setup(layout: RightSidebarLayoutState = LAYOUT, workspaceId = WORKSPACE_ID) {
  const client = setupSimpleChatStory({
    workspaceId,
    workspaceName: "phone-sidebar",
    projectName: "xum",
    experiments: { [EXPERIMENT_IDS.ARTIFACTS]: true, [EXPERIMENT_IDS.AGENT_BROWSER]: true },
    messages: [
      createUserMessage("u1", "How do I get to the Browser tool on a phone?", {
        historySequence: 1,
        timestamp: Date.parse(AT) - 60_000,
      }),
      createAssistantMessage("a1", "Open the workspace menu and pick Browser.", {
        historySequence: 2,
        timestamp: Date.parse(AT),
      }),
    ],
  });
  updatePersistedState(LEFT_SIDEBAR_COLLAPSED_KEY, true);
  // Collapsed on a wide layout earlier: opening the full-screen view expands it.
  updatePersistedState(RIGHT_SIDEBAR_COLLAPSED_KEY, true);
  updatePersistedState(getRightSidebarLayoutKey(workspaceId), layout);
  // The Browser tool polls for sessions; this story has none.
  client.browser = {
    ...client.browser,
    listSessions: () => Promise.resolve({ sessions: [], otherSessions: [] }),
  };
  client.workflows.listScripts = () => Promise.resolve([]);
  client.workflows.listRuns = () => Promise.resolve([]);
  client.workflows.getRun = () => Promise.resolve(RUN);
  client.workflows.subscribe = (_input, options) => {
    const queue = createAsyncMessageQueue<WorkflowRunStreamEvent>();
    queue.push({ type: "snapshot", runs: [RUN] });
    options?.signal?.addEventListener("abort", queue.end, { once: true });
    return Promise.resolve(wrapAsyncIterator(queue.iterate(), {}));
  };
  return client;
}

function PhoneFrameDecorator(Story: ComponentType) {
  return (
    <div data-phone-frame="" style={{ width: 390, height: 844, overflow: "hidden" }}>
      <Story />
    </div>
  );
}

async function openSidebarFromMenu(canvasElement: HTMLElement) {
  await userEvent.click(within(canvasElement).getByTestId("workspace-more-actions"));
  const page = within(canvasElement.ownerDocument.body);
  await userEvent.click(await page.findByTestId("workspace-open-sidebar"));
}

export const FullScreenFromWorkspaceMenu: AppStory = {
  decorators: [PhoneFrameDecorator],
  parameters: { ...appMeta.parameters, pixel: PIXEL_DISABLED },
  render: () => <AppWithMocks setup={setup} />,
  play: async ({ canvasElement }) => {
    await waitForChatInputAutofocusDone(canvasElement);
    const canvas = within(canvasElement);
    const page = within(canvasElement.ownerDocument.body);
    const sidebar = canvasElement.querySelector<HTMLElement>('[aria-label="Workspace insights"]');
    if (sidebar == null) throw new Error("right sidebar missing");
    const moreButton = canvas.getByTestId("workspace-more-actions");
    const chatPane = canvas.getByRole("log", { name: "Conversation transcript" });
    await waitFor(() => expect(sidebar).not.toBeVisible());

    // One Sidebar row stands in for the hidden sidebar. It shows the sidebar full-screen on the
    // tab it shows (Workflows), expanded although it was collapsed. The chat behind it is inert.
    await openSidebarFromMenu(canvasElement);
    await waitFor(() => expect(sidebar).toBeVisible());
    await expect(within(sidebar).getByRole("tab", { name: /Workflows/ })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    await within(sidebar).findByText(RUN_NAME);
    // Everything behind the view is inert, not just the chat: the left sidebar and the footer
    // sit outside the chat pane.
    await expect(chatPane.closest("[inert]")).not.toBeNull();
    const expandLeftSidebar = canvas.getByRole("button", { name: "Expand sidebar", hidden: true });
    await expect(expandLeftSidebar.closest("[inert]")).not.toBeNull();
    // Focus moves into the view and stays there. The closing menu returns focus to the More
    // button on a timer, which must not win: the inert chat pane cannot take focus. Check again
    // after that timer had its turn.
    await waitFor(() => expect(sidebar.contains(document.activeElement)).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(sidebar.contains(document.activeElement)).toBe(true);

    // Its New tab launcher opens the tools that have no tab yet, Browser among them.
    await userEvent.click(within(sidebar).getByRole("button", { name: "New tab" }));
    await userEvent.click(await within(sidebar).findByRole("button", { name: /^Browser/ }));
    await expect(within(sidebar).getByRole("tab", { name: /Browser/ })).toHaveAttribute(
      "aria-selected",
      "true"
    );

    // Closing keeps the panels mounted and returns focus.
    await userEvent.click(within(sidebar).getByRole("tab", { name: /Workflows/ }));
    const runTitle = await within(sidebar).findByText(RUN_NAME);
    await userEvent.click(within(sidebar).getByRole("button", { name: "Close sidebar" }));
    await waitFor(() => expect(sidebar).not.toBeVisible());
    await waitFor(() => expect(moreButton).toHaveFocus());
    await expect(chatPane.closest("[inert]")).toBeNull();
    await expect(expandLeftSidebar.closest("[inert]")).toBeNull();
    // Opening the view expanded the sidebar (it was collapsed), so its panels stay mounted.
    await expect(readPersistedState(RIGHT_SIDEBAR_COLLAPSED_KEY, true)).toBe(false);

    // Reopening shows the tab used last, the same panel instance, not a remounted copy.
    await openSidebarFromMenu(canvasElement);
    await waitFor(() => expect(sidebar).toBeVisible());
    await expect(within(sidebar).getByText(RUN_NAME)).toBe(runTitle);

    // Focus is on a tab, which shows no shortcut tooltip on a phone (a tooltip would also take
    // the first Escape). Escape closes the view.
    await waitFor(() => expect(sidebar.contains(document.activeElement)).toBe(true));
    await expect(page.queryByRole("tooltip")).toBeNull();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(sidebar).not.toBeVisible());

    // A shortcut past the last tab (the ninth, with two tabs), or one pressed behind an open
    // modal or from the command palette, leaves the chat in view. The handler requests the view synchronously, so one task
    // later a wrong request would already show.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "9", code: "Digit9", ctrlKey: true }));
    const modal = document.createElement("div");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    document.body.appendChild(modal);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "2", code: "Digit2", ctrlKey: true }));
    modal.remove();
    // The command palette is not a modal dialog to isDialogOpen(), so it has its own check.
    const palette = document.createElement("div");
    palette.setAttribute("cmdk-root", "");
    const paletteInput = document.createElement("input");
    palette.appendChild(paletteInput);
    document.body.appendChild(palette);
    paletteInput.dispatchEvent(
      new KeyboardEvent("keydown", { key: "2", code: "Digit2", ctrlKey: true, bubbles: true })
    );
    palette.remove();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(sidebar).not.toBeVisible();

    // The tab shortcuts are the keyboard path to the Sidebar row: the second tab's shortcut
    // shows the view on that tab (Browser).
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "2", code: "Digit2", ctrlKey: true }));
    await waitFor(() => expect(sidebar).toBeVisible());
    await expect(within(sidebar).getByRole("tab", { name: /Browser/ })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(sidebar).not.toBeVisible());

    // The New tab shortcut opens the full-screen sidebar on a New tab (Linux/Windows binding).
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "n", code: "KeyN", ctrlKey: true, altKey: true })
    );
    await waitFor(() => expect(sidebar).toBeVisible());
    await expect(await within(sidebar).findByText("Open a tool")).toBeVisible();
    await waitFor(() => expect(sidebar.contains(document.activeElement)).toBe(true));

    // A layout change that removes the focused tab, as pruning does once a tool turns out to be
    // unavailable, keeps focus inside the view instead of dropping it on the inert page.
    updatePersistedState(getRightSidebarLayoutKey(WORKSPACE_ID), LAYOUT);
    await waitFor(() => expect(within(sidebar).queryByText("Open a tool")).toBeNull());
    await waitFor(() => expect(sidebar.contains(document.activeElement)).toBe(true));

    // Widening the layout ends full-screen mode: the sidebar is back in its column. Only
    // possible when the window itself is wider than the narrow viewport breakpoint.
    if (window.innerWidth >= 1000) {
      const frame = canvasElement.querySelector<HTMLElement>("[data-phone-frame]");
      if (frame == null) throw new Error("phone frame missing");
      frame.style.width = `${window.innerWidth}px`;
      await waitFor(() => expect(sidebar).not.toHaveClass("right-sidebar-fullscreen"));
      await expect(sidebar).toBeVisible();
      await expect(within(sidebar).queryByRole("button", { name: "Close sidebar" })).toBeNull();
    }
  },
};

// Two panes, the second focused: Goal above, Workflows below.
const SPLIT_LAYOUT: RightSidebarLayoutState = {
  version: 1,
  nextId: 4,
  focusedTabsetId: "tabset-3",
  openTabsOnly: true,
  root: {
    type: "split",
    id: "split-2",
    direction: "horizontal",
    sizes: [50, 50],
    children: [
      { type: "tabset", id: "tabset-1", tabs: ["goal"], activeTab: "goal" },
      { type: "tabset", id: "tabset-3", tabs: ["workflows"], activeTab: "workflows" },
    ],
  },
};

/**
 * Opening the view focuses the focused pane's tab, so the pane stays focused. The workspace id
 * has a quote, as legacy ids built from paths can: finding the tab must not build a selector
 * from it (querySelector would throw with the page already inert).
 */
export const SplitLayoutKeepsFocusedPane: AppStory = {
  decorators: [PhoneFrameDecorator],
  parameters: { ...appMeta.parameters, pixel: PIXEL_DISABLED },
  render: () => <AppWithMocks setup={() => setup(SPLIT_LAYOUT, 'xum-legacy"quoted')} />,
  play: async ({ canvasElement }) => {
    await waitForChatInputAutofocusDone(canvasElement);
    const sidebar = canvasElement.querySelector<HTMLElement>('[aria-label="Workspace insights"]');
    if (sidebar == null) throw new Error("right sidebar missing");
    await openSidebarFromMenu(canvasElement);
    await waitFor(() => expect(sidebar).toBeVisible());
    const workflowsTab = within(sidebar).getByRole("tab", { name: /Workflows/ });
    await waitFor(() => expect(workflowsTab).toHaveFocus());
    // The New tab shortcut adds to the focused pane: still the Workflows pane, not Goal's.
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "n", code: "KeyN", ctrlKey: true, altKey: true })
    );
    const newTab = await within(sidebar).findByRole("tab", { name: /New tab/ });
    await expect(newTab.closest('[role="tablist"]')?.contains(workflowsTab) ?? false).toBe(true);
  },
};

/** The sidebar opened from the workspace menu's Sidebar row, full-screen at the phone viewport. */
export const FullScreenSidebarOnPhone: AppStory = {
  // A phone viewport for local viewing (the fixed frame does not move innerWidth).
  globals: {
    viewport: { value: "mobile2", isRotated: false },
  },
  decorators: [PhoneFrameDecorator],
  render: () => <AppWithMocks setup={setup} />,
  // Dark only: the snapshot budget (scripts/check-storybook-snapshot-budget.mjs) is nearly full.
  parameters: {
    ...appMeta.parameters,
    pixel: { matrix: { themes: ["dark"], viewports: ["phone"] } },
  },
  play: async ({ canvasElement }) => {
    await waitForChatInputAutofocusDone(canvasElement);
    const sidebar = canvasElement.querySelector<HTMLElement>('[aria-label="Workspace insights"]');
    if (sidebar == null) throw new Error("right sidebar missing");
    await openSidebarFromMenu(canvasElement);
    await waitFor(() => expect(sidebar).toBeVisible());
    await within(sidebar).findByText(RUN_NAME);
    await waitFor(() => expect(sidebar.contains(document.activeElement)).toBe(true));
  },
};
