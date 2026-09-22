import type { ComponentType } from "react";
import { expect, userEvent, waitFor, within } from "@storybook/test";
import { createActivityFeed } from "./mocks/activityFeed";
import { createMockORPCClient } from "./mocks/orpc";
import { groupWorkspacesByProject } from "./mocks/workspaces";
import { expandLeftSidebar, expandProjects, selectWorkspace } from "./helpers/uiState";

import { getSubAgentTasksExpandedKey } from "@/common/constants/storage";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { workspaceStore } from "@/browser/stores/WorkspaceStore";
import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import { setupSimpleChatStory } from "./helpers/chatSetup";
import { collapseLeftSidebar, collapseRightSidebar } from "./helpers/uiState";
import { createAssistantMessage, createUserMessage } from "./mocks/messages";
import { createWorkspace, STABLE_TIMESTAMP } from "./mocks/workspaces";

const PARENT_WORKSPACE_ID = "ws-persistent-subagents";
const PROJECT_NAME = "xum";
const PROJECT_PATH = "/home/user/projects/mux";

function setupPersistentSubagentsStory() {
  collapseLeftSidebar();
  collapseRightSidebar();
  updatePersistedState(getSubAgentTasksExpandedKey(PARENT_WORKSPACE_ID), true);

  return setupSimpleChatStory({
    workspaceId: PARENT_WORKSPACE_ID,
    workspaceName: "persistent-subagents",
    projectName: PROJECT_NAME,
    projectPath: PROJECT_PATH,
    messages: [
      createUserMessage("subagents-user", "Delegate the implementation and verification work.", {
        historySequence: 1,
        timestamp: STABLE_TIMESTAMP - 120_000,
      }),
      createAssistantMessage(
        "subagents-assistant",
        "I split the work across persistent sub-agents. Their workspaces remain available until I archive them.",
        { historySequence: 2, timestamp: STABLE_TIMESTAMP - 110_000 }
      ),
    ],
    additionalWorkspaces: [
      createWorkspace({
        id: "subagent-active",
        name: "agent_exec_implementation",
        title: "Implement persistent lifecycle",
        projectName: PROJECT_NAME,
        projectPath: PROJECT_PATH,
        parentWorkspaceId: PARENT_WORKSPACE_ID,
        taskStatus: "running",
      }),
      createWorkspace({
        id: "subagent-completed",
        name: "agent_explore_verification",
        title: "Verify cleanup ownership",
        projectName: PROJECT_NAME,
        projectPath: PROJECT_PATH,
        parentWorkspaceId: PARENT_WORKSPACE_ID,
        taskStatus: "reported",
      }),
      createWorkspace({
        id: "subagent-nested",
        name: "agent_explore_sidebar",
        title: "Check narrow layout",
        projectName: PROJECT_NAME,
        projectPath: PROJECT_PATH,
        parentWorkspaceId: "subagent-active",
        taskStatus: "reported",
      }),
    ],
  });
}

function PhoneDecorator(Story: ComponentType) {
  return (
    <div
      data-testid="subagent-phone-frame"
      style={{ width: "100%", maxWidth: 390, height: 844, overflow: "hidden" }}
    >
      <Story />
    </div>
  );
}

export default {
  ...appMeta,
  title: "App/PersistentSubagents",
};

const MONITORED_CHILD_ID = "subagent-monitored";
const MONITORED_CHILD_TITLE = "Verification watcher";

// Set by the story setup so the play can move the child's armed-monitor count after
// mount (the tray and sidebar must follow live activity, not just the initial snapshot).
let emitMonitorCount: (activeBashMonitorCount: number) => void = () => {
  throw new Error("BackgroundMonitor story setup has not run");
};

function setupMonitoredSubagentStory(sidebarExpanded = true) {
  const parent = createWorkspace({
    id: PARENT_WORKSPACE_ID,
    name: "waiting-for-verification",
    projectName: PROJECT_NAME,
    projectPath: PROJECT_PATH,
  });
  const child = {
    ...createWorkspace({
      id: MONITORED_CHILD_ID,
      name: "verification-watcher",
      title: MONITORED_CHILD_TITLE,
      projectName: PROJECT_NAME,
      projectPath: PROJECT_PATH,
      parentWorkspaceId: parent.id,
      taskStatus: "reported",
    }),
    taskExecutionStatus: "completed" as const,
  };
  const monitorActivity = (activeBashMonitorCount: number) => ({
    recency: STABLE_TIMESTAMP,
    // Keep the stale live hint armed even after the final monitor retires. The
    // completed report, not a conveniently idle stream, must fence off activity.
    streaming: true,
    lastModel: null,
    lastThinkingLevel: null,
    activeBashMonitorCount,
  });
  const activityFeed = createActivityFeed();
  emitMonitorCount = (count) => activityFeed.emit(child.id, monitorActivity(count));
  if (sidebarExpanded) {
    expandLeftSidebar();
  } else {
    collapseLeftSidebar();
  }
  collapseRightSidebar();
  expandProjects([PROJECT_PATH]);
  selectWorkspace(parent);
  updatePersistedState(getSubAgentTasksExpandedKey(PARENT_WORKSPACE_ID), true);
  const client = createMockORPCClient({
    projects: groupWorkspacesByProject([parent, child]),
    workspaces: [parent, child],
    workspaceActivitySnapshots: { [child.id]: monitorActivity(0) },
  });
  client.workspace.activity.subscribe = activityFeed.subscribe;
  return client;
}

export const BackgroundMonitor: AppStory = {
  render: () => <AppWithMocks setup={setupMonitoredSubagentStory} />,
  parameters: {
    ...appMeta.parameters,
    pixel: { matrix: { themes: ["dark", "light"], viewports: ["laptop"] } },
  },
  play: async ({ canvasElement, step }) => {
    const sidebar = () => within(canvasElement).getByTestId("left-sidebar");
    const sidebarRow = () =>
      canvasElement.querySelector(`[data-workspace-id="${MONITORED_CHILD_ID}"][role="button"]`);
    const tray = () => {
      const element = canvasElement.querySelector<HTMLElement>(
        '[data-component="SubAgentTasksDecoration"]'
      );
      if (element == null) {
        throw new Error("SubAgentTasksDecoration tray is not rendered");
      }
      return element;
    };
    // The row's accessible name is "<title> <status label>", so match the title prefix.
    const trayRow = () =>
      within(tray()).queryByRole("button", { name: new RegExp(`^${MONITORED_CHILD_TITLE}`) });
    // Store propagation through activity -> sidebar state -> both surfaces can exceed the
    // 1s default on loaded CI runners.
    const settle = (assertion: () => Promise<void>) => waitFor(assertion, { timeout: 5_000 });
    // Both surfaces read the same store, so the sidebar row (#4328) and the composer
    // tray (#4327) must agree at every step.
    const expectMonitored = (monitorCount = 1) =>
      settle(async () => {
        await expect(workspaceStore.getWorkspaceSidebarState(MONITORED_CHILD_ID)).toMatchObject({
          canInterrupt: true,
          awaitingUserQuestion: false,
          activeBashMonitorCount: monitorCount,
        });
        // A closed phone drawer unmounts its rows; it must not prevent the
        // visible composer from exercising the same live activity transitions.
        if (sidebar().classList.contains("mobile-sidebar-collapsed")) {
          await expect(sidebarRow()).toBeNull();
        } else {
          await expect(sidebarRow()).toBeVisible();
        }
        await expect(tray()).toHaveTextContent("1 sub-agent · 1 active");
        await expect(trayRow()).toHaveTextContent("Monitoring");
      });
    const expectSettled = () =>
      settle(async () => {
        // Assert the actual store hint, not just the mock input: otherwise the
        // completed-report fence could pass without ever seeing stale activity.
        await expect(workspaceStore.getWorkspaceSidebarState(MONITORED_CHILD_ID)).toMatchObject({
          canInterrupt: true,
          awaitingUserQuestion: false,
          activeBashMonitorCount: 0,
        });
        await expect(sidebarRow()).toBeNull();
        await expect(tray()).toHaveTextContent("1 sub-agent · inactive");
        await expect(trayRow()).toHaveTextContent("Completed");
      });

    await step("A completed report fences off stale streaming without a monitor", async () => {
      await expectSettled();
      await expect(sidebar().classList.contains("mobile-sidebar-collapsed")).toBe(
        canvasElement.querySelector('[data-testid="subagent-phone-frame"]') !== null
      );
    });
    await step("Arming a monitor activates the reported child in sidebar and tray", async () => {
      emitMonitorCount(1);
      await expectMonitored();
    });
    await step("Collapsing hides the rows; expanding brings them back", async () => {
      await userEvent.click(within(tray()).getAllByRole("button")[0]);
      await settle(async () => {
        await expect(trayRow()).toBeNull();
        await expect(tray()).toHaveTextContent("1 sub-agent · 1 active");
      });
      await userEvent.click(within(tray()).getAllByRole("button")[0]);
      await expectMonitored();
    });
    await step("A second monitor counts the same child once", async () => {
      emitMonitorCount(2);
      await expectMonitored(2);
    });
    await step("Retiring one of two monitors keeps the child active", async () => {
      emitMonitorCount(1);
      await expectMonitored();
    });
    await step("Retiring the last monitor settles the child everywhere", async () => {
      emitMonitorCount(0);
      await expectSettled();
    });
    await step("Re-arming a monitor reactivates the child everywhere", async () => {
      emitMonitorCount(1);
      await expectMonitored();
    });
  },
};

export const BackgroundMonitorPhone: AppStory = {
  ...BackgroundMonitor,
  render: () => <AppWithMocks setup={() => setupMonitoredSubagentStory(false)} />,
  globals: { viewport: { value: "mobile1", isRotated: false } },
  decorators: [PhoneDecorator],
  parameters: {
    ...appMeta.parameters,
    pixel: { matrix: { themes: ["dark", "light"], viewports: ["phone"] } },
  },
};

export const Expanded: AppStory = {
  render: () => <AppWithMocks setup={setupPersistentSubagentsStory} />,
  parameters: {
    ...appMeta.parameters,
    pixel: { matrix: { themes: ["dark", "light"], viewports: ["laptop"] } },
  },
};

export const Phone: AppStory = {
  tags: ["!test"],
  globals: {
    viewport: { value: "mobile1", isRotated: false },
  },
  render: () => <AppWithMocks setup={setupPersistentSubagentsStory} />,
  decorators: [PhoneDecorator],
  parameters: {
    ...appMeta.parameters,
    pixel: { matrix: { themes: ["dark", "light"], viewports: ["phone"] } },
  },
};
