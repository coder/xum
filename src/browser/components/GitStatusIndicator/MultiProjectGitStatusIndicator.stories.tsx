import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, waitFor, within } from "storybook/test";
import { useEffect, useMemo } from "react";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import { createWorkspace, groupWorkspacesByProject } from "@/browser/stories/mocks/workspaces";
import { lightweightMeta } from "@/browser/stories/meta.js";
import { clearGitStatus, useGitStatusStoreRaw } from "@/browser/stores/GitStatusStore";
import type { ProjectGitStatusResult as ApiProjectGitStatusResult } from "@/common/orpc/schemas/api";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { MultiProjectGitStatusIndicator } from "./MultiProjectGitStatusIndicator";

function createMultiProjectWorkspace(
  workspaceId: string,
  primaryProjectName: string
): FrontendWorkspaceMetadata {
  return {
    ...createWorkspace({
      id: workspaceId,
      name: "feature/multi-project-status",
      projectName: primaryProjectName,
      createdAt: "2023-11-14T22:13:20.000Z",
    }),
    projects: [
      {
        projectPath: `/home/user/projects/${primaryProjectName}`,
        projectName: "app",
      },
      {
        projectPath: "/home/user/projects/docs",
        projectName: "docs",
      },
    ],
  };
}

const DIVERGED_WORKSPACE = createMultiProjectWorkspace("ws-multi-diverged", "app-diverged-story");
const CLEAN_WORKSPACE = createMultiProjectWorkspace("ws-multi-clean", "app-clean-story");
const DIALOG_WORKSPACE = createMultiProjectWorkspace("ws-multi-dialog", "app-dialog-story");

const DIVERGED_PROJECT_STATUSES: ApiProjectGitStatusResult[] = [
  {
    projectPath: "/home/user/projects/app-diverged",
    projectName: "app",
    gitStatus: {
      branch: "main",
      ahead: 2,
      behind: 1,
      dirty: false,
      outgoingAdditions: 14,
      outgoingDeletions: 3,
      incomingAdditions: 8,
      incomingDeletions: 2,
    },
    error: null,
  },
  {
    projectPath: "/home/user/projects/docs",
    projectName: "docs",
    gitStatus: {
      branch: "main",
      ahead: 0,
      behind: 0,
      dirty: false,
      outgoingAdditions: 0,
      outgoingDeletions: 0,
      incomingAdditions: 0,
      incomingDeletions: 0,
    },
    error: null,
  },
];

const CLEAN_PROJECT_STATUSES: ApiProjectGitStatusResult[] = [
  {
    projectPath: "/home/user/projects/app-clean",
    projectName: "app",
    gitStatus: {
      branch: "main",
      ahead: 0,
      behind: 0,
      dirty: false,
      outgoingAdditions: 0,
      outgoingDeletions: 0,
      incomingAdditions: 0,
      incomingDeletions: 0,
    },
    error: null,
  },
  {
    projectPath: "/home/user/projects/docs",
    projectName: "docs",
    gitStatus: {
      branch: "main",
      ahead: 0,
      behind: 0,
      dirty: false,
      outgoingAdditions: 0,
      outgoingDeletions: 0,
      incomingAdditions: 0,
      incomingDeletions: 0,
    },
    error: null,
  },
];

const DIALOG_PROJECT_STATUSES: ApiProjectGitStatusResult[] = [
  {
    projectPath: "/home/user/projects/app-dialog",
    projectName: "app",
    gitStatus: {
      branch: "main",
      ahead: 2,
      behind: 1,
      dirty: false,
      outgoingAdditions: 14,
      outgoingDeletions: 3,
      incomingAdditions: 8,
      incomingDeletions: 2,
    },
    error: null,
  },
  {
    projectPath: "/home/user/projects/docs",
    projectName: "docs",
    gitStatus: {
      branch: "main",
      ahead: 0,
      behind: 0,
      dirty: true,
      outgoingAdditions: 4,
      outgoingDeletions: 1,
      incomingAdditions: 0,
      incomingDeletions: 0,
    },
    error: null,
  },
];

function MultiProjectIndicatorStory(props: {
  workspace: FrontendWorkspaceMetadata;
  projectStatuses: ApiProjectGitStatusResult[];
}) {
  const gitStatusStore = useGitStatusStoreRaw();
  const client = useMemo(
    () =>
      createMockORPCClient({
        projects: groupWorkspacesByProject([props.workspace]),
        workspaces: [props.workspace],
        projectGitStatusesByWorkspace: new Map([[props.workspace.id, props.projectStatuses]]),
      }),
    [props.projectStatuses, props.workspace]
  );

  useEffect(() => {
    gitStatusStore.setClient(client);
    gitStatusStore.syncWorkspaces(new Map([[props.workspace.id, props.workspace]]));

    return () => {
      clearGitStatus(props.workspace.id);
      gitStatusStore.syncWorkspaces(new Map());
      gitStatusStore.setClient(null);
    };
  }, [client, gitStatusStore, props.workspace]);

  return (
    <div className="bg-background p-6">
      <MultiProjectGitStatusIndicator workspaceId={props.workspace.id} />
    </div>
  );
}

async function waitForMultiProjectChip(
  canvasElement: HTMLElement,
  expectedText: string
): Promise<HTMLButtonElement> {
  const canvas = within(canvasElement);
  const chip = await canvas.findByRole(
    "button",
    { name: /open multi-project git status details/i },
    { timeout: 10000 }
  );

  await waitFor(() => {
    if (!chip.textContent?.includes(expectedText)) {
      throw new Error(`Expected multi-project git chip to include "${expectedText}".`);
    }
  });

  return chip as HTMLButtonElement;
}

const meta = {
  ...lightweightMeta,
  title: "Components/GitStatusIndicator/MultiProjectGitStatusIndicator",
  component: MultiProjectGitStatusIndicator,
} satisfies Meta<typeof MultiProjectGitStatusIndicator>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Diverged: Story = {
  render: () => (
    <MultiProjectIndicatorStory
      workspace={DIVERGED_WORKSPACE}
      projectStatuses={DIVERGED_PROJECT_STATUSES}
    />
  ),
  play: async ({ canvasElement }) => {
    await waitForMultiProjectChip(canvasElement, "1 diverged");
  },
};

export const Clean: Story = {
  render: () => (
    <MultiProjectIndicatorStory
      workspace={CLEAN_WORKSPACE}
      projectStatuses={CLEAN_PROJECT_STATUSES}
    />
  ),
  play: async ({ canvasElement }) => {
    await waitForMultiProjectChip(canvasElement, "2 repos");
  },
};

export const DialogOpen: Story = {
  render: () => (
    <MultiProjectIndicatorStory
      workspace={DIALOG_WORKSPACE}
      projectStatuses={DIALOG_PROJECT_STATUSES}
    />
  ),
  play: async ({ canvasElement }) => {
    const chip = await waitForMultiProjectChip(canvasElement, "1 diverged");
    await userEvent.click(chip);

    const body = within(canvasElement.ownerDocument.body);
    const dialog = await waitFor(() => {
      const foundDialog = body.getByRole("dialog");
      if (!foundDialog.textContent?.includes("Multi-project git status")) {
        throw new Error("Multi-project git status dialog not rendered yet.");
      }
      return foundDialog;
    });

    const dialogScope = within(dialog);
    await dialogScope.findByText("Project");
    await dialogScope.findByText("docs");
    await dialogScope.findByText("1 dirty");
  },
};
