import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, waitFor, within } from "@storybook/test";
import { type ReactNode, useEffect, useMemo } from "react";
import { APIProvider } from "@/browser/contexts/API";
import { ProjectProvider } from "@/browser/contexts/ProjectContext";
import { RouterProvider } from "@/browser/contexts/RouterContext";
import { WorkspaceProvider } from "@/browser/contexts/WorkspaceContext";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import { NOW, createArchivedWorkspace } from "@/browser/stories/mocks/workspaces";
import { lightweightMeta } from "@/browser/stories/meta.js";
import { useWorkspaceStoreRaw } from "@/browser/stores/WorkspaceStore";
import { getProvidersConfigStore } from "@/browser/stores/ProvidersConfigStore";
import { getArchivedWorkspacesExpandedKey } from "@/common/constants/storage";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { ArchivedWorkspaces } from "./ArchivedWorkspaces";

const PROJECT_PATH = "/Users/dev/my-project";
const PROJECT_NAME = "my-project";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const ARCHIVED_WORKSPACES: FrontendWorkspaceMetadata[] = [
  {
    ...createArchivedWorkspace({
      id: "archived-title-1",
      name: "bugfix/agent-report-rendering",
      projectName: PROJECT_NAME,
      projectPath: PROJECT_PATH,
      createdAt: new Date(NOW - 2 * HOUR).toISOString(),
      archivedAt: new Date(NOW - 15 * MINUTE).toISOString(),
    }),
    title: "Fix agent report rendering",
  },
  createArchivedWorkspace({
    id: "archived-2",
    name: "feature/sub-agent-costs",
    projectName: PROJECT_NAME,
    projectPath: PROJECT_PATH,
    createdAt: new Date(NOW - 3 * HOUR).toISOString(),
    archivedAt: new Date(NOW - 30 * MINUTE).toISOString(),
  }),
  createArchivedWorkspace({
    id: "archived-3",
    name: "refactor/mcp-config",
    projectName: PROJECT_NAME,
    projectPath: PROJECT_PATH,
    createdAt: new Date(NOW - 4 * HOUR).toISOString(),
    archivedAt: new Date(NOW - 45 * MINUTE).toISOString(),
  }),
  createArchivedWorkspace({
    id: "archived-4",
    name: "chore/remove-truncation",
    projectName: PROJECT_NAME,
    projectPath: PROJECT_PATH,
    createdAt: new Date(NOW - 5 * HOUR).toISOString(),
    archivedAt: new Date(NOW - 60 * MINUTE).toISOString(),
  }),
];

function ArchivedWorkspacesStoryShell(props: {
  children: ReactNode;
  workspaces: FrontendWorkspaceMetadata[];
}) {
  const workspaceStore = useWorkspaceStoreRaw();
  const client = useMemo(
    () =>
      createMockORPCClient({
        projects: new Map([[PROJECT_PATH, { workspaces: [] }]]),
        workspaces: props.workspaces,
      }),
    [props.workspaces]
  );

  useEffect(() => {
    workspaceStore.setClient(client);
    // useProvidersConfig consumers read the shared store, which gets its
    // client from AppLoader in the real app — wire it manually here too.
    getProvidersConfigStore().setClient(client);
    return () => {
      workspaceStore.setClient(null);
      getProvidersConfigStore().setClient(null);
    };
  }, [client, workspaceStore]);

  return (
    <APIProvider client={client}>
      <RouterProvider>
        <ProjectProvider>
          <WorkspaceProvider>{props.children}</WorkspaceProvider>
        </ProjectProvider>
      </RouterProvider>
    </APIProvider>
  );
}

function renderArchivedWorkspaces(): JSX.Element {
  updatePersistedState(getArchivedWorkspacesExpandedKey(PROJECT_PATH), true);

  return (
    <ArchivedWorkspacesStoryShell workspaces={ARCHIVED_WORKSPACES}>
      <div className="bg-background p-6">
        <div className="max-w-4xl">
          <ArchivedWorkspaces
            projectPath={PROJECT_PATH}
            projectName={PROJECT_NAME}
            workspaces={ARCHIVED_WORKSPACES}
          />
        </div>
      </div>
    </ArchivedWorkspacesStoryShell>
  );
}

const meta = {
  ...lightweightMeta,
  title: "Components/ArchivedWorkspaces",
  component: ArchivedWorkspaces,
} satisfies Meta<typeof ArchivedWorkspaces>;

export default meta;

type Story = StoryObj<typeof meta>;

export const ArchivedWorkspaceList: Story = {
  render: () => renderArchivedWorkspaces(),
};

export const WorkspaceNameInRuntimeTooltip: Story = {
  render: () => renderArchivedWorkspaces(),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    const checkbox = await canvas.findByLabelText(
      "Select Fix agent report rendering",
      {},
      { timeout: 10000 }
    );

    const row = checkbox.closest<HTMLDivElement>("div");
    if (!row) {
      throw new Error("Archived workspace row not found");
    }

    const runtimeIcon = row.querySelector("svg");
    if (!runtimeIcon) {
      throw new Error("Runtime icon not found");
    }

    const runtimeBadge = runtimeIcon.closest<HTMLElement>("span");
    if (!runtimeBadge) {
      throw new Error("Runtime badge trigger not found");
    }

    await userEvent.hover(runtimeBadge);

    await waitFor(
      () => {
        const tooltip = canvasElement.ownerDocument.querySelector('[role="tooltip"]');
        if (!tooltip) {
          throw new Error("Tooltip not visible");
        }

        const tooltipWithin = within(tooltip as HTMLElement);
        tooltipWithin.getByText("Worktree: isolated git worktree");
        tooltipWithin.getByText("Name");
        tooltipWithin.getByText("bugfix/agent-report-rendering");
      },
      { interval: 50 }
    );
  },
};
