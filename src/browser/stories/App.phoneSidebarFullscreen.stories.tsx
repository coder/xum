/**
 * Phones: the narrow layout hides the right sidebar, so the workspace menu lists its tools and
 * opens them in the sidebar itself, shown full-screen.
 *
 * The story pins a 390px frame instead of relying on the viewport, so the shell's container query
 * hides the sidebar at any window size (the Storybook test-runner plays at desktop size). Play-only:
 * Pixel does not snapshot it.
 */
import { wrapAsyncIterator } from "@orpc/shared";
import { expect, userEvent, waitFor, within } from "@storybook/test";
import type { ComponentType } from "react";

import { updatePersistedState } from "@/browser/hooks/usePersistedState";
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
  parameters: { ...appMeta.parameters, pixel: PIXEL_DISABLED },
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
// open yet and is reachable only through the menu.
const LAYOUT: RightSidebarLayoutState = {
  version: 1,
  nextId: 2,
  focusedTabsetId: "tabset-1",
  openTabsOnly: true,
  root: { type: "tabset", id: "tabset-1", tabs: ["workflows"], activeTab: "workflows" },
};

function setup() {
  const client = setupSimpleChatStory({
    workspaceId: WORKSPACE_ID,
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
  updatePersistedState(RIGHT_SIDEBAR_COLLAPSED_KEY, false);
  updatePersistedState(getRightSidebarLayoutKey(WORKSPACE_ID), LAYOUT);
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

async function pickMenuTool(canvasElement: HTMLElement, tool: string) {
  await userEvent.click(within(canvasElement).getByTestId("workspace-more-actions"));
  const page = within(canvasElement.ownerDocument.body);
  await userEvent.click(await page.findByTestId(`workspace-sidebar-tool-${tool}`));
}

export const FullScreenFromWorkspaceMenu: AppStory = {
  decorators: [PhoneFrameDecorator],
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

    // The menu lists the launcher's tools, including Browser, which no tab has opened yet.
    // Stats, Timeline and Artifacts keep their own dialogs, so they get no tool row.
    await userEvent.click(moreButton);
    await expect(await page.findByTestId("workspace-sidebar-tool-browser")).toBeVisible();
    for (const tool of ["costs", "timeline", "artifacts"]) {
      await expect(page.queryByTestId(`workspace-sidebar-tool-${tool}`)).not.toBeInTheDocument();
    }
    await userEvent.click(page.getByTestId("workspace-sidebar-tool-browser"));

    // The real sidebar shows full-screen on the new Browser tab; the chat behind it is inert.
    await waitFor(() => expect(sidebar).toBeVisible());
    await expect(within(sidebar).getByRole("tab", { name: /Browser/ })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    await expect(chatPane.closest("[inert]")).not.toBeNull();
    // Focus moves to the picked tool and stays there. The closing menu returns focus to the More
    // button on a timer, which must not win: the inert chat pane cannot take focus. Check again
    // after that timer had its turn.
    await waitFor(() => expect(sidebar.contains(document.activeElement)).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(sidebar.contains(document.activeElement)).toBe(true);

    // Its own strip switches tools. Closing keeps the panel mounted and returns focus.
    await userEvent.click(within(sidebar).getByRole("tab", { name: /Workflows/ }));
    const runTitle = await within(sidebar).findByText(RUN_NAME);
    await userEvent.click(within(sidebar).getByRole("button", { name: "Close sidebar" }));
    await waitFor(() => expect(sidebar).not.toBeVisible());
    await waitFor(() => expect(moreButton).toHaveFocus());
    await expect(chatPane.closest("[inert]")).toBeNull();

    // Reopening shows the same panel instance, not a remounted copy.
    await pickMenuTool(canvasElement, "workflows");
    await waitFor(() => expect(sidebar).toBeVisible());
    await expect(within(sidebar).getByText(RUN_NAME)).toBe(runTitle);

    // Escape closes it. (Focus on a tab shows that tab's tooltip, which takes the first Escape,
    // so press it from the close button.)
    within(sidebar).getByRole("button", { name: "Close sidebar" }).focus();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(sidebar).not.toBeVisible());

    // The New tab shortcut opens the full-screen sidebar on a New tab (Linux/Windows binding).
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "n", code: "KeyN", ctrlKey: true, altKey: true })
    );
    await waitFor(() => expect(sidebar).toBeVisible());
    await expect(await within(sidebar).findByText("Open a tool")).toBeVisible();

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
