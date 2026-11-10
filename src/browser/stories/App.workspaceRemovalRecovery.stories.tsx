import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { NARROW_VIEWPORT_MAX_WIDTH_PX } from "@/constants/layout";
import type { APIClient } from "@/browser/contexts/API";
import type { WorkspaceBackgroundProcessBlocker } from "@/common/types/workspace";
import { appMeta, AppWithMocks, PIXEL_DISABLED, type AppStory } from "./meta.js";
import {
  collapseRightSidebar,
  expandProjects,
  expandRightSidebar,
  selectWorkspace,
} from "./helpers/uiState";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { getRightSidebarLayoutKey } from "@/common/constants/storage";
import { makeSideChatTabType } from "@/browser/types/rightSidebar";
import { getDefaultRightSidebarLayoutState } from "@/browser/utils/rightSidebarLayout";
import { createMockORPCClient } from "./mocks/orpc";
import { createWorkspace, groupWorkspacesByProject } from "./mocks/workspaces";
import { clickWhenReady } from "./storyPlayHelpers";

export default {
  ...appMeta,
  title: "App/WorkspaceRemovalRecovery",
};

const workspace = createWorkspace({
  id: "workspace-removal-recovery",
  name: "recover-process-records",
  projectName: "demo-app",
  title: "Recover damaged process records",
});
const sideChat = {
  ...createWorkspace({
    id: "side-chat-removal-recovery",
    name: "side-chat-removal-recovery",
    projectName: workspace.projectName,
    title: "Side question",
  }),
  sideChatParentWorkspaceId: workspace.id,
};
const records: WorkspaceBackgroundProcessBlocker[] = [
  {
    workspaceId: workspace.id,
    processId: "empty-record",
    recordPath: "/home/developer/.xum/sessions/workspace-removal-recovery/processes/empty-record",
    state: "unknown",
    reason: "The process record has no metadata.",
  },
  {
    workspaceId: workspace.id,
    processId: "damaged-record-with-a-long-name",
    recordPath:
      "/home/developer/.xum/sessions/workspace-removal-recovery/processes/damaged-record-with-a-long-name",
    state: "unknown",
    reason: "The process record contains invalid metadata.",
  },
];

const remove = fn<APIClient["workspace"]["remove"]>();

function setupRecovery(withSideChat = false) {
  selectWorkspace(workspace);
  collapseRightSidebar();
  expandProjects([workspace.projectPath]);
  if (withSideChat) {
    expandRightSidebar(workspace.id);
    updatePersistedState(
      getRightSidebarLayoutKey(workspace.id),
      getDefaultRightSidebarLayoutState(makeSideChatTabType(sideChat.id))
    );
  }
  remove.mockReset();
  remove.mockResolvedValue({
    success: false,
    error: "Unknown background process activity blocks removal.",
    backgroundProcesses: records.map((record) => ({
      ...record,
      workspaceId: withSideChat ? sideChat.id : workspace.id,
    })),
  });
  const workspaces = withSideChat ? [workspace, sideChat] : [workspace];
  const client = createMockORPCClient({
    projects: groupWorkspacesByProject(workspaces),
    workspaces,
  });
  client.workspace.remove = remove;
  return client;
}

async function openRecovery(canvasElement: HTMLElement) {
  const body = within(canvasElement.ownerDocument.body);
  await userEvent.keyboard("{Control>}{Shift>}p{/Shift}{/Control}");
  await userEvent.keyboard(">Remove Current Workspace");
  await userEvent.click(await body.findByText("Remove Current Workspace…"));
  await clickWhenReady(await body.findByRole("button", { name: "Remove" }));
  return body.findByRole("dialog", { name: "Remove workspace with unknown process activity?" });
}

async function exerciseRecovery(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const body = within(canvasElement.ownerDocument.body);
  await canvas.findAllByText(workspace.title!);
  let dialog = await openRecovery(canvasElement);
  await expect(remove).toHaveBeenCalledTimes(1);

  await clickWhenReady(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(body.queryByRole("dialog")).toBeNull());
  await expect(remove).toHaveBeenCalledTimes(1);
  const error = await body.findByRole("alert");
  await userEvent.click(within(error).getByRole("button", { name: "Dismiss" }));

  dialog = await openRecovery(canvasElement);
  await expect(remove).toHaveBeenCalledTimes(2);
  for (const call of remove.mock.calls) {
    await expect(call[0]).toEqual({ workspaceId: workspace.id, options: undefined });
  }
  const details = within(dialog).getByRole("region", { name: "Unknown process records" });
  for (const record of records) {
    await expect(details).toHaveTextContent(record.recordPath);
    await expect(details).toHaveTextContent(record.reason);
  }
  await expect(
    within(dialog).getByRole("button", { name: "Accept risk and remove workspace" })
  ).toBeEnabled();

  // The test runner uses a desktop viewport. Pixel and the manager run the phone checks.
  if (window.innerWidth < 768) {
    for (const element of [dialog, ...dialog.querySelectorAll<HTMLElement>("button, li")]) {
      const bounds = element.getBoundingClientRect();
      await expect(bounds.left).toBeGreaterThanOrEqual(0);
      await expect(bounds.right).toBeLessThanOrEqual(window.innerWidth);
      await expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth);
    }
    const hints = [...dialog.querySelectorAll<HTMLElement>('span[aria-hidden="true"]')].filter(
      (element) => element.textContent === "N" || element.textContent === "Y"
    );
    await expect(hints).toHaveLength(2);
    for (const hint of hints) await expect(hint).not.toBeVisible();
  }
}

export const Desktop: AppStory = {
  globals: { viewport: { value: "removalDesktop", isRotated: false } },
  parameters: {
    viewport: {
      options: {
        removalDesktop: {
          name: "Removal desktop",
          styles: { width: "1900px", height: "1000px" },
          type: "desktop",
        },
      },
    },
    // The phone snapshot covers wrapping. Keep desktop interactions without a duplicate capture.
    pixel: { ...PIXEL_DISABLED, matrix: { viewports: ["desktop"] } },
  },
  render: () => <AppWithMocks setup={setupRecovery} />,
  play: async ({ canvasElement, parameters }) => {
    await expect(parameters.pixel).toMatchObject({ matrix: { viewports: ["desktop"] } });
    await exerciseRecovery(canvasElement);
  },
};

export const SideChat: AppStory = {
  parameters: { pixel: PIXEL_DISABLED },
  render: () => <AppWithMocks setup={() => setupRecovery(true)} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const body = within(canvasElement.ownerDocument.body);
    if (window.innerWidth <= NARROW_VIEWPORT_MAX_WIDTH_PX) {
      await clickWhenReady(await canvas.findByTestId("workspace-more-actions"));
      await clickWhenReady(await body.findByTestId("workspace-open-sidebar"));
    }
    const close = await canvas.findByRole("button", { name: "Close side chat" });
    await clickWhenReady(close);
    let dialog = await body.findByRole("dialog");
    await clickWhenReady(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(body.queryByRole("dialog")).toBeNull());
    await expect(remove).toHaveBeenCalledTimes(1);
    await expect(close).toBeInTheDocument();

    await clickWhenReady(close);
    dialog = await body.findByRole("dialog");
    remove.mockResolvedValue({ success: true });
    await clickWhenReady(
      within(dialog).getByRole("button", { name: "Accept risk and remove workspace" })
    );
    await waitFor(() =>
      expect(canvas.queryByRole("button", { name: "Close side chat" })).toBeNull()
    );
    await expect(remove.mock.calls.map((call) => call[0])).toEqual([
      { workspaceId: sideChat.id, options: { force: true } },
      { workspaceId: sideChat.id, options: { force: true } },
      {
        workspaceId: sideChat.id,
        options: {
          force: true,
          acknowledgedUnknownProcessRecords: records.map((record) => record.recordPath),
        },
      },
    ]);
  },
};

export const Phone: AppStory = {
  ...Desktop,
  globals: { viewport: { value: "removalPhone", isRotated: false } },
  parameters: {
    viewport: {
      options: {
        removalPhone: {
          name: "Removal phone",
          styles: { width: "390px", height: "844px" },
          type: "mobile",
        },
      },
    },
    pixel: { matrix: { viewports: ["phone"] } },
  },
  play: async ({ canvasElement, parameters }) => {
    await expect(parameters.pixel).toMatchObject({ matrix: { viewports: ["phone"] } });
    await exerciseRecovery(canvasElement);
  },
};
