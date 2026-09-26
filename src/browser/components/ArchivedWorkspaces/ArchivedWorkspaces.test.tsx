import "../../../../tests/ui/dom";

import { type ComponentProps, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  waitForElementToBeRemoved,
} from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";
import * as APIModule from "@/browser/contexts/API";
import type { APIClient } from "@/browser/contexts/API";
import type * as WorkspaceStoreModule from "@/browser/stores/WorkspaceStore";
import * as WorkspaceContextModule from "@/browser/contexts/WorkspaceContext";
import * as TooltipModule from "@/browser/components/Tooltip/Tooltip";
import * as ForceDeleteModalModule from "@/browser/components/ForceDeleteModal/ForceDeleteModal";
import * as RuntimeBadgeModule from "@/browser/components/RuntimeBadge/RuntimeBadge";
import * as SkeletonModule from "@/browser/components/Skeleton/Skeleton";
import * as OptimisticBatchLRUModule from "@/browser/hooks/useOptimisticBatchLRU";
import type { FrontendWorkspaceMetadata, WorkspaceRemoveResult } from "@/common/types/workspace";

import * as AgentContextModule from "@/browser/contexts/AgentContext";
import * as ThinkingContextModule from "@/browser/contexts/ThinkingContext";
import * as ChatInputModule from "@/browser/features/ChatInput";
import * as ProvidersConfigModule from "@/browser/hooks/useProvidersConfig";
import * as ProjectMCPOverviewModule from "@/browser/components/ProjectMCPOverview/ProjectMCPOverview";
import { ProjectPage } from "@/browser/components/ProjectPage/ProjectPage";
import { ScratchPage } from "@/browser/components/ScratchPage/ScratchPage";
import {
  getArchivedWorkspacesExpandedKey,
  getArchivedWorkspacesKey,
} from "@/common/constants/storage";
import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";

import { ArchivedWorkspaces } from "./ArchivedWorkspaces";

function installTestDoubles() {
  // Re-register the full WorkspaceStore mock before each test to avoid Bun's global mock leakage.
  /* eslint-disable @typescript-eslint/no-require-imports */
  const actualWorkspaceStore =
    require("@/browser/stores/WorkspaceStore?real=1") as typeof WorkspaceStoreModule;
  /* eslint-enable @typescript-eslint/no-require-imports */

  void mock.module("@/browser/stores/WorkspaceStore", () => ({
    ...actualWorkspaceStore,
  }));
}

function stubPageChrome() {
  spyOn(AgentContextModule, "AgentProvider").mockImplementation((props) => <>{props.children}</>);
  spyOn(ThinkingContextModule, "ThinkingProvider").mockImplementation((props) => (
    <>{props.children}</>
  ));
  spyOn(ChatInputModule, "ChatInput").mockImplementation(
    (() => null) as unknown as typeof ChatInputModule.ChatInput
  );
  spyOn(ProjectMCPOverviewModule, "ProjectMCPOverview").mockImplementation(() => null);
  spyOn(ProvidersConfigModule, "useProvidersConfig").mockImplementation(() => ({
    config: null,
    loading: true,
    refresh: () => Promise.resolve(),
    updateOptimistically: () => undefined,
    updateModelsOptimistically: () => [],
  }));
}

function stubPageApi(list: APIClient["workspace"]["list"], getSessionUsageBatch: unknown) {
  // eslint-disable-next-line local/no-unknown-cast-to-api-client -- #4627 (double needs type repair)
  const api = {
    workspace: {
      list,
      getSessionUsageBatch,
      onMetadata: async function* () {
        yield* await Promise.resolve([]);
      },
    },
    projects: { listBranches: () => Promise.resolve({ branches: ["main"] }) },
  } as unknown as APIClient;
  spyOn(APIModule, "useAPI").mockImplementation(() => ({
    api,
    status: "connected",
    error: null,
    authenticate: () => undefined,
    retry: () => undefined,
  }));
}

const pageProps = {
  leftSidebarCollapsed: false,
  onToggleLeftSidebarCollapsed: () => undefined,
  onWorkspaceCreated: () => undefined,
};

function createWorkspace(overrides: Partial<FrontendWorkspaceMetadata>): FrontendWorkspaceMetadata {
  return {
    id: overrides.id ?? "ws-1",
    name: overrides.name ?? "workspace-1",
    projectName: overrides.projectName ?? "project",
    projectPath: overrides.projectPath ?? "/tmp/project",
    createdAt: overrides.createdAt ?? "2026-03-01T00:00:00.000Z",
    archivedAt: overrides.archivedAt ?? "2026-03-02T00:00:00.000Z",
    runtimeConfig: overrides.runtimeConfig ?? { type: "worktree", srcBaseDir: "/tmp/src" },
    namedWorkspacePath: overrides.namedWorkspacePath ?? "/tmp/src/project/workspace-1",
    ...overrides,
  };
}

let cleanupDom: (() => void) | null = null;

describe("ArchivedWorkspaces", () => {
  const deleteWorktreeMock = mock(() => Promise.resolve({ success: true }));
  const getSessionUsageBatchMock = mock(() => Promise.resolve({}));
  const unarchiveWorkspaceMock = mock(() => Promise.resolve({ success: true }));
  const removeWorkspaceMock = mock(
    (
      _workspaceId: string,
      _options?: { force?: boolean; acknowledgedDescendantIds?: string[] }
    ): Promise<WorkspaceRemoveResult> => Promise.resolve({ success: true })
  );
  let modalProps: ComponentProps<typeof ForceDeleteModalModule.ForceDeleteModal> | undefined;
  const setSelectedWorkspaceMock = mock(() => undefined);
  const onWorkspacesChangedMock = mock(() => undefined);

  beforeEach(() => {
    modalProps = undefined;
    installTestDoubles();
    cleanupDom = installDom();
    deleteWorktreeMock.mockClear();
    getSessionUsageBatchMock.mockClear();
    unarchiveWorkspaceMock.mockClear();
    removeWorkspaceMock.mockClear();
    setSelectedWorkspaceMock.mockClear();
    onWorkspacesChangedMock.mockClear();
    localStorage.clear();

    spyOn(APIModule, "useAPI").mockImplementation(() => ({
      // eslint-disable-next-line local/no-unknown-cast-to-api-client -- #4627 (double needs type repair)
      api: {
        workspace: {
          deleteWorktree: deleteWorktreeMock,
          getSessionUsageBatch: getSessionUsageBatchMock,
        },
      } as unknown as APIClient,
      status: "connected",
      error: null,
      authenticate: () => undefined,
      retry: () => undefined,
    }));

    spyOn(WorkspaceContextModule, "useWorkspaceContext").mockImplementation(
      () =>
        ({
          unarchiveWorkspace: unarchiveWorkspaceMock,
          removeWorkspace: removeWorkspaceMock,
          setSelectedWorkspace: setSelectedWorkspaceMock,
        }) as unknown as ReturnType<typeof WorkspaceContextModule.useWorkspaceContext>
    );

    spyOn(TooltipModule, "Tooltip").mockImplementation(((props: { children: ReactNode }) => (
      <>{props.children}</>
    )) as unknown as typeof TooltipModule.Tooltip);
    spyOn(TooltipModule, "TooltipTrigger").mockImplementation(((props: { children: ReactNode }) => (
      <>{props.children}</>
    )) as unknown as typeof TooltipModule.TooltipTrigger);
    spyOn(TooltipModule, "TooltipContent").mockImplementation(((props: { children: ReactNode }) => (
      <>{props.children}</>
    )) as unknown as typeof TooltipModule.TooltipContent);
    spyOn(ForceDeleteModalModule, "ForceDeleteModal").mockImplementation((props) => {
      modalProps = props;
      return null;
    });
    spyOn(RuntimeBadgeModule, "RuntimeBadge").mockImplementation((() => (
      <span data-testid="runtime-badge" />
    )) as unknown as typeof RuntimeBadgeModule.RuntimeBadge);
    spyOn(SkeletonModule, "Skeleton").mockImplementation((() => (
      <div data-testid="skeleton" />
    )) as unknown as typeof SkeletonModule.Skeleton);
    spyOn(OptimisticBatchLRUModule, "useOptimisticBatchLRU").mockImplementation((() => ({
      values: {},
      status: "success",
    })) as unknown as typeof OptimisticBatchLRUModule.useOptimisticBatchLRU);
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("fetches costs only while expanded, including when metadata is already cached", async () => {
    spyOn(OptimisticBatchLRUModule, "useOptimisticBatchLRU").mockRestore();
    const workspace = createWorkspace({ id: "lazy-cost" });
    const readWorkspaceId = mock(() => "lazy-cost");
    Object.defineProperty(workspace, "id", { get: readWorkspaceId });
    const view = render(
      <ArchivedWorkspaces
        projectPath={workspace.projectPath}
        projectName={workspace.projectName}
        workspaces={[workspace]}
      />
    );
    expect(getSessionUsageBatchMock).not.toHaveBeenCalled();
    expect(view.queryByRole("region", { name: "Archived workspaces" })).toBeNull();
    expect(readWorkspaceId).not.toHaveBeenCalled();
    // A collapsed header must not advertise a count it cannot keep fresh.
    expect(view.getByText("Archived Workspaces").textContent).toBe("Archived Workspaces");
    fireEvent.click(view.getByLabelText("Expand archived workspaces"));
    expect(view.getByText("Archived Workspaces (1)")).toBeTruthy();
    await waitFor(() => expect(getSessionUsageBatchMock).toHaveBeenCalledTimes(1));
    expect(getSessionUsageBatchMock).toHaveBeenCalledWith({ workspaceIds: [workspace.id] });
    fireEvent.click(view.getByLabelText("Collapse archived workspaces"));
    view.rerender(
      <ArchivedWorkspaces
        projectPath={workspace.projectPath}
        projectName={workspace.projectName}
        workspaces={[workspace, createWorkspace({ id: "new-archive" })]}
      />
    );
    expect(getSessionUsageBatchMock).toHaveBeenCalledTimes(1);
  });

  test.each(["project", "cached-project", "scratch"])(
    "defers archived metadata and usage on the %s page until expansion",
    async (page) => {
      spyOn(OptimisticBatchLRUModule, "useOptimisticBatchLRU").mockRestore();
      stubPageChrome();
      const workspace = createWorkspace({
        id: "lazy-page-" + page,
        ...(page === "scratch" ? { kind: "scratch" as const } : {}),
      });
      const allArchived = [
        workspace,
        ...Array.from({ length: 1254 }, (_, i) =>
          createWorkspace({ id: "other-" + i, projectPath: "/other-project" })
        ),
      ];
      const list = mock(() => Promise.resolve(allArchived));
      stubPageApi(list, getSessionUsageBatchMock);
      if (page === "cached-project")
        updatePersistedState(getArchivedWorkspacesKey(workspace.projectPath), []);
      const view = render(
        page === "scratch" ? (
          <ScratchPage {...pageProps} />
        ) : (
          <ProjectPage
            {...pageProps}
            projectPath={workspace.projectPath}
            projectName={workspace.projectName}
          />
        )
      );
      expect(list).not.toHaveBeenCalled();
      expect(getSessionUsageBatchMock).not.toHaveBeenCalled();
      fireEvent.click(view.getByLabelText("Expand archived workspaces"));
      await waitFor(() => expect(getSessionUsageBatchMock).toHaveBeenCalledTimes(1));
      expect(list).toHaveBeenCalledTimes(1);
      expect(list).toHaveBeenCalledWith({ archived: true });
      expect(getSessionUsageBatchMock).toHaveBeenCalledWith({ workspaceIds: [workspace.id] });
      expect(view.getByLabelText("Restore workspace " + workspace.name)).toBeTruthy();
    }
  );

  test("resets archived state when the project page switches projects", () => {
    stubPageChrome();
    stubPageApi(
      mock(() => new Promise<FrontendWorkspaceMetadata[]>(() => undefined)),
      getSessionUsageBatchMock
    );
    const cached = createWorkspace({ id: "a-1", name: "from-a", projectPath: "/project-a" });
    updatePersistedState(getArchivedWorkspacesKey("/project-a"), [cached]);
    updatePersistedState(getArchivedWorkspacesExpandedKey("/project-a"), true);
    updatePersistedState(getArchivedWorkspacesExpandedKey("/project-b"), true);
    const view = render(<ProjectPage {...pageProps} projectPath="/project-a" projectName="a" />);
    expect(view.getByLabelText("Restore workspace from-a")).toBeTruthy();
    view.rerender(<ProjectPage {...pageProps} projectPath="/project-b" projectName="b" />);
    expect(view.queryByLabelText("Restore workspace from-a")).toBeNull();
    expect(view.getByRole("region", { name: "Archived workspaces" }).textContent).toContain(
      "Loading archived workspaces"
    );
  });

  test("shows a refresh failure above cached rows without hiding them", () => {
    updatePersistedState(getArchivedWorkspacesExpandedKey("/tmp/project"), true);
    const workspace = createWorkspace({ id: "cached-1", name: "cached" });
    const view = render(
      <ArchivedWorkspaces
        projectPath="/tmp/project"
        projectName="project"
        workspaces={[workspace]}
        loadError="disk on fire"
      />
    );
    const region = view.getByRole("region", { name: "Archived workspaces" });
    expect(region.textContent).toContain("Failed to load archived workspaces: disk on fire");
    expect(view.getByLabelText("Restore workspace cached")).toBeTruthy();
  });

  test("persists the refreshed archive list after a restore", async () => {
    stubPageChrome();
    const workspace = createWorkspace({ id: "restore-me", name: "restore-me" });
    const list = mock(() => Promise.resolve([workspace]));
    stubPageApi(list, getSessionUsageBatchMock);
    updatePersistedState(getArchivedWorkspacesExpandedKey(workspace.projectPath), true);
    const view = render(
      <ProjectPage
        {...pageProps}
        projectPath={workspace.projectPath}
        projectName={workspace.projectName}
      />
    );
    const restore = await waitFor(() => view.getByLabelText("Restore workspace restore-me"));
    list.mockImplementation(() => Promise.resolve<FrontendWorkspaceMetadata[]>([]));
    fireEvent.click(restore);
    await waitForElementToBeRemoved(() => view.queryByLabelText("Restore workspace restore-me"));
    expect(
      readPersistedState<FrontendWorkspaceMetadata[] | undefined>(
        getArchivedWorkspacesKey(workspace.projectPath),
        undefined
      )
    ).toEqual([]);
  });

  test("distinguishes a pending archive load from an empty archive", () => {
    updatePersistedState(getArchivedWorkspacesExpandedKey("/tmp/project"), true);
    const props = { projectPath: "/tmp/project", projectName: "project" };
    const view = render(<ArchivedWorkspaces {...props} workspaces={undefined} />);
    const regionText = () => view.getByRole("region", { name: "Archived workspaces" }).textContent;
    expect(regionText()).toContain("Loading archived workspaces");
    expect(regionText()).not.toContain("No workspaces match");
    view.rerender(
      <ArchivedWorkspaces {...props} workspaces={undefined} loadError="disk on fire" />
    );
    expect(regionText()).toContain("Failed to load archived workspaces");
    expect(regionText()).toContain("disk on fire");
    view.rerender(<ArchivedWorkspaces {...props} workspaces={[]} />);
    expect(regionText()).toContain("No archived workspaces");
    expect(regionText()).not.toContain("No workspaces match");
  });

  test.each(["project", "scratch"])(
    "surfaces an archived list load failure on the %s page",
    async (page) => {
      stubPageChrome();
      const list = mock(() => Promise.reject(new Error("list exploded")));
      stubPageApi(list, getSessionUsageBatchMock);
      const view = render(
        page === "scratch" ? (
          <ScratchPage {...pageProps} />
        ) : (
          <ProjectPage {...pageProps} projectPath="/tmp/project" projectName="project" />
        )
      );
      fireEvent.click(view.getByLabelText("Expand archived workspaces"));
      await waitFor(() =>
        expect(view.getByRole("region", { name: "Archived workspaces" }).textContent).toContain(
          "list exploded"
        )
      );
      expect(view.queryByText(/No workspaces match/)).toBeNull();
    }
  );

  test("shows an error when restoring an archived workspace fails", async () => {
    unarchiveWorkspaceMock.mockImplementationOnce(() =>
      Promise.resolve({ success: false, error: "Restore failed" })
    );
    const workspace = createWorkspace({
      id: "ws-restore-error",
      name: "restore-error",
    });

    const view = render(
      <ArchivedWorkspaces
        projectPath={workspace.projectPath}
        projectName={workspace.projectName}
        workspaces={[workspace]}
        onWorkspacesChanged={onWorkspacesChangedMock}
      />
    );

    fireEvent.click(view.getByLabelText("Expand archived workspaces"));

    const restoreButton = await waitFor(() =>
      view.getByLabelText(`Restore workspace ${workspace.name}`)
    );
    fireEvent.click(restoreButton);

    await waitFor(() => {
      expect(unarchiveWorkspaceMock).toHaveBeenCalledWith(workspace.id);
    });
    expect(onWorkspacesChangedMock).not.toHaveBeenCalled();

    const alert = await waitFor(() => view.getByRole("alert"));
    expect(alert.textContent).toContain("Failed to restore workspace");
    expect(alert.textContent).toContain("Restore failed");
  });

  test("bulk deletion removes selected descendants before their parent", async () => {
    const parent = createWorkspace({
      id: "parent",
      name: "parent",
    });
    const child = createWorkspace({
      id: "child",
      name: "child",
      parentWorkspaceId: parent.id,
    });

    const view = render(
      <ArchivedWorkspaces
        projectPath={parent.projectPath}
        projectName={parent.projectName}
        workspaces={[parent, child]}
        onWorkspacesChanged={onWorkspacesChangedMock}
      />
    );

    fireEvent.click(view.getByLabelText("Expand archived workspaces"));
    fireEvent.click(await waitFor(() => view.getByLabelText("Select parent")));
    fireEvent.click(view.getByLabelText("Select child"));
    fireEvent.click(view.getByLabelText("Delete selected"));
    fireEvent.click(view.getByRole("button", { name: "Yes, delete 2" }));

    await waitFor(() => {
      expect(removeWorkspaceMock).toHaveBeenCalledTimes(2);
    });
    expect(removeWorkspaceMock.mock.calls.map((call) => call[0])).toEqual([child.id, parent.id]);
    expect(removeWorkspaceMock.mock.calls.every((call) => call[1]?.force === true)).toBe(true);
  });

  test("Shift-click acknowledges reported descendants without a confirmation", async () => {
    const workspace = createWorkspace({ id: "parent", name: "parent" });
    const descendants = [
      { workspaceId: "grandchild", title: "Grandchild", active: false },
      { workspaceId: "child", title: "Child", active: false },
    ];
    removeWorkspaceMock.mockResolvedValueOnce({
      success: false,
      error: "Confirm children",
      descendants,
    });
    const view = render(
      <ArchivedWorkspaces
        projectPath={workspace.projectPath}
        projectName={workspace.projectName}
        workspaces={[workspace]}
        onWorkspacesChanged={onWorkspacesChangedMock}
      />
    );
    fireEvent.click(view.getByLabelText("Expand archived workspaces"));
    fireEvent.click(await waitFor(() => view.getByLabelText("Delete workspace parent")), {
      shiftKey: true,
    });
    await waitFor(() => expect(onWorkspacesChangedMock).toHaveBeenCalledTimes(1));
    expect(removeWorkspaceMock).toHaveBeenCalledTimes(2);
    expect(removeWorkspaceMock).toHaveBeenNthCalledWith(1, workspace.id);
    expect(removeWorkspaceMock).toHaveBeenNthCalledWith(2, workspace.id, {
      force: true,
      acknowledgedDescendantIds: ["grandchild", "child"],
    });
    expect(modalProps).toBeUndefined();
  });

  test("Shift-click falls back to the modal when the acknowledged retry fails", async () => {
    const workspace = createWorkspace({ id: "parent", name: "parent" });
    const descendants = [{ workspaceId: "child", title: "Child", active: false }];
    removeWorkspaceMock.mockResolvedValueOnce({
      success: false,
      error: "Confirm children",
      descendants,
    });
    const retryFailure = {
      success: false,
      error: "Child starts running",
      descendants: [{ ...descendants[0], active: true }],
    };
    removeWorkspaceMock.mockResolvedValueOnce(retryFailure);
    const view = render(
      <ArchivedWorkspaces
        projectPath={workspace.projectPath}
        projectName={workspace.projectName}
        workspaces={[workspace]}
        onWorkspacesChanged={onWorkspacesChangedMock}
      />
    );
    fireEvent.click(view.getByLabelText("Expand archived workspaces"));
    fireEvent.click(await waitFor(() => view.getByLabelText("Delete workspace parent")), {
      shiftKey: true,
    });
    await waitFor(() => expect(modalProps?.descendants).toEqual(retryFailure.descendants));
    expect(modalProps?.error).toBe(retryFailure.error);
    expect(removeWorkspaceMock).toHaveBeenCalledTimes(2);
    expect(removeWorkspaceMock).toHaveBeenLastCalledWith(workspace.id, {
      force: true,
      acknowledgedDescendantIds: ["child"],
    });
    expect(onWorkspacesChangedMock).not.toHaveBeenCalled();
    if (!modalProps) throw new Error("Expected deletion confirmation");
    expect(await modalProps.onForceDelete(workspace.id, ["child"])).toEqual({ success: true });
    expect(removeWorkspaceMock).toHaveBeenLastCalledWith(workspace.id, {
      force: true,
      acknowledgedDescendantIds: ["child"],
    });
    expect(onWorkspacesChangedMock).toHaveBeenCalledTimes(1);
  });

  test("Shift-click still forces deletion without descendants", async () => {
    const workspace = createWorkspace({ id: "parent", name: "parent" });
    removeWorkspaceMock.mockResolvedValueOnce({ success: false, error: "Dirty checkout" });
    const view = render(
      <ArchivedWorkspaces
        projectPath={workspace.projectPath}
        projectName={workspace.projectName}
        workspaces={[workspace]}
        onWorkspacesChanged={onWorkspacesChangedMock}
      />
    );
    fireEvent.click(view.getByLabelText("Expand archived workspaces"));
    fireEvent.click(await waitFor(() => view.getByLabelText("Delete workspace parent")), {
      shiftKey: true,
    });
    await waitFor(() => expect(onWorkspacesChangedMock).toHaveBeenCalledTimes(1));
    expect(removeWorkspaceMock).toHaveBeenNthCalledWith(1, workspace.id);
    expect(removeWorkspaceMock).toHaveBeenNthCalledWith(2, workspace.id, { force: true });
    expect(modalProps).toBeUndefined();
  });

  test("shows delete worktree for archived worktree workspaces and calls the API", async () => {
    const workspace = createWorkspace({
      id: "ws-worktree",
      name: "worktree-ws",
      transcriptOnly: false,
    });

    const view = render(
      <ArchivedWorkspaces
        projectPath={workspace.projectPath}
        projectName={workspace.projectName}
        workspaces={[workspace]}
        onWorkspacesChanged={onWorkspacesChangedMock}
      />
    );

    fireEvent.click(view.getByLabelText("Expand archived workspaces"));

    const deleteWorktreeButton = await waitFor(() =>
      view.getByLabelText(`Remove local checkout for workspace ${workspace.name}`)
    );
    fireEvent.click(deleteWorktreeButton);

    await waitFor(() => {
      expect(deleteWorktreeMock).toHaveBeenCalledWith({ workspaceId: workspace.id });
    });
    expect(onWorkspacesChangedMock).toHaveBeenCalledTimes(1);
  });

  test("shows an error when single-workspace delete worktree fails", async () => {
    deleteWorktreeMock.mockImplementationOnce(() =>
      Promise.resolve({ success: false, error: "Permission denied" })
    );
    const workspace = createWorkspace({
      id: "ws-worktree-error",
      name: "worktree-error",
      transcriptOnly: false,
    });

    const view = render(
      <ArchivedWorkspaces
        projectPath={workspace.projectPath}
        projectName={workspace.projectName}
        workspaces={[workspace]}
        onWorkspacesChanged={onWorkspacesChangedMock}
      />
    );

    fireEvent.click(view.getByLabelText("Expand archived workspaces"));

    const deleteWorktreeButton = await waitFor(() =>
      view.getByLabelText(`Remove local checkout for workspace ${workspace.name}`)
    );
    fireEvent.click(deleteWorktreeButton);

    await waitFor(() => {
      expect(deleteWorktreeMock).toHaveBeenCalledWith({ workspaceId: workspace.id });
    });
    expect(onWorkspacesChangedMock).not.toHaveBeenCalled();

    const alert = await waitFor(() => view.getByRole("alert"));
    expect(alert.textContent).toContain("Failed to delete managed worktree");
    expect(alert.textContent).toContain("Permission denied");
  });

  test("hides delete worktree when an archived workspace does not own a managed checkout", async () => {
    const transcriptOnlyWorkspace = createWorkspace({
      id: "ws-transcript-only",
      name: "transcript-only",
      transcriptOnly: true,
    });
    const localWorkspace = createWorkspace({
      id: "ws-local",
      name: "local-ws",
      runtimeConfig: { type: "local" },
      transcriptOnly: false,
    });

    const sharedCheckoutWorkspace = createWorkspace({
      id: "ws-shared-checkout",
      name: "shared-checkout",
      taskIsolation: "none",
      transcriptOnly: false,
    });

    const view = render(
      <ArchivedWorkspaces
        projectPath={transcriptOnlyWorkspace.projectPath}
        projectName={transcriptOnlyWorkspace.projectName}
        workspaces={[transcriptOnlyWorkspace, localWorkspace, sharedCheckoutWorkspace]}
      />
    );

    fireEvent.click(view.getByLabelText("Expand archived workspaces"));

    await waitFor(() => {
      expect(
        view.queryByLabelText(`Remove local checkout for workspace ${transcriptOnlyWorkspace.name}`)
      ).toBeNull();
      expect(
        view.queryByLabelText(`Remove local checkout for workspace ${localWorkspace.name}`)
      ).toBeNull();
      expect(
        view.queryByLabelText(`Remove local checkout for workspace ${sharedCheckoutWorkspace.name}`)
      ).toBeNull();
    });
  });
});
