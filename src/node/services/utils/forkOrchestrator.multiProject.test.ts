import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import type { RuntimeConfig } from "@/common/types/runtime";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import type { Config } from "@/node/config";
import { ContainerManager } from "@/node/multiProject/containerManager";
import { MultiProjectRuntime } from "@/node/runtime/multiProjectRuntime";
import type { InitLogger, Runtime, WorkspaceForkResult } from "@/node/runtime/Runtime";
import * as runtimeFactoryModule from "@/node/runtime/runtimeFactory";
import * as gitModule from "@/node/git";
import * as runtimeUpdatesModule from "@/node/services/utils/forkRuntimeUpdates";
import { orchestrateFork } from "./forkOrchestrator";

const SRC_BASE_DIR = "/tmp/mux-src";
const PROJECT_ONE_PATH = "/projects/one";
const PROJECT_TWO_PATH = "/projects/two";
const PROJECTS = [
  { projectPath: PROJECT_ONE_PATH, projectName: "project-one" },
  { projectPath: PROJECT_TWO_PATH, projectName: "project-two" },
];
const SOURCE_WORKSPACE_NAME = "feature/source";
const NEW_WORKSPACE_NAME = "feature/child";
const SOURCE_WORKSPACE_ID = "workspace-parent";
const CONTAINER_PATH = `${SRC_BASE_DIR}/_workspaces/${NEW_WORKSPACE_NAME}`;

const SOURCE_RUNTIME_CONFIG: RuntimeConfig = {
  type: "worktree",
  srcBaseDir: SRC_BASE_DIR,
};

interface ProjectRuntimeMocks {
  runtime: Runtime;
  forkWorkspace: ReturnType<typeof vi.fn>;
  createWorkspace: ReturnType<typeof vi.fn>;
  deleteWorkspace: ReturnType<typeof vi.fn>;
}

function createInitLogger(): InitLogger {
  return {
    logStep: vi.fn(),
    logStdout: vi.fn(),
    logStderr: vi.fn(),
    logComplete: vi.fn(),
  };
}

function createConfig(projectTrustByPath: Record<string, boolean> = {}): Config {
  return {
    srcDir: SRC_BASE_DIR,
    updateWorkspaceMetadata: vi.fn(),
    loadConfigOrDefault: vi.fn(() => ({
      projects: new Map(
        Object.entries(projectTrustByPath).map(([projectPath, trusted]) => [
          projectPath,
          { workspaces: [], trusted },
        ])
      ),
    })),
  } as unknown as Config;
}

function createParentMetadata(): WorkspaceMetadata {
  return {
    id: SOURCE_WORKSPACE_ID,
    name: SOURCE_WORKSPACE_NAME,
    projectName: "project-one+project-two",
    projectPath: PROJECT_ONE_PATH,
    createdAt: "2026-03-03T00:00:00.000Z",
    runtimeConfig: SOURCE_RUNTIME_CONFIG,
    projects: PROJECTS,
  };
}

function createProjectRuntimeMocks(): ProjectRuntimeMocks {
  const forkWorkspace = vi.fn();
  const createWorkspace = vi.fn();
  const deleteWorkspace = vi.fn();
  const runtime = {
    forkWorkspace,
    createWorkspace,
    deleteWorkspace,
  } as unknown as Runtime;

  return { runtime, forkWorkspace, createWorkspace, deleteWorkspace };
}

async function runOrchestrateFork(params: {
  parentMetadata: WorkspaceMetadata;
  config?: Config;
  trusted?: boolean;
  preferredTrunkBranch?: string;
  multiProjectExperimentEnabled?: boolean;
}): Promise<Awaited<ReturnType<typeof orchestrateFork>>> {
  return orchestrateFork({
    sourceRuntime: createProjectRuntimeMocks().runtime,
    projectPath: PROJECT_ONE_PATH,
    sourceWorkspaceName: SOURCE_WORKSPACE_NAME,
    newWorkspaceName: NEW_WORKSPACE_NAME,
    initLogger: createInitLogger(),
    config:
      params.config ??
      createConfig({
        [PROJECT_ONE_PATH]: true,
        [PROJECT_TWO_PATH]: true,
      }),
    sourceWorkspaceId: SOURCE_WORKSPACE_ID,
    sourceRuntimeConfig: SOURCE_RUNTIME_CONFIG,
    parentMetadata: params.parentMetadata,
    allowCreateFallback: true,
    trusted: params.trusted,
    preferredTrunkBranch: params.preferredTrunkBranch,
    multiProjectExperimentEnabled: params.multiProjectExperimentEnabled ?? true,
  });
}

let applyForkRuntimeUpdatesMock!: ReturnType<
  typeof spyOn<typeof runtimeUpdatesModule, "applyForkRuntimeUpdates">
>;
let createRuntimeMock!: ReturnType<typeof spyOn<typeof runtimeFactoryModule, "createRuntime">>;
let createContainerMock!: ReturnType<typeof spyOn<ContainerManager, "createContainer">>;
let removeContainerMock!: ReturnType<typeof spyOn<ContainerManager, "removeContainer">>;

let listLocalBranchesMock!: ReturnType<typeof spyOn<typeof gitModule, "listLocalBranches">>;
let detectDefaultTrunkBranchMock!: ReturnType<
  typeof spyOn<typeof gitModule, "detectDefaultTrunkBranch">
>;

function mockProjectRuntimes(
  projectOneRuntime: ProjectRuntimeMocks,
  projectTwoRuntime: ProjectRuntimeMocks
): void {
  const targetProjectOneRuntime = { marker: "target-project-one" } as unknown as Runtime;
  const targetProjectTwoRuntime = { marker: "target-project-two" } as unknown as Runtime;

  createRuntimeMock.mockImplementation((_runtimeConfig, options) => {
    if (!options?.projectPath || !options.workspaceName) {
      throw new Error("Expected projectPath and workspaceName for createRuntime");
    }

    if (
      options.workspaceName === SOURCE_WORKSPACE_NAME &&
      options.projectPath === PROJECT_ONE_PATH
    ) {
      return projectOneRuntime.runtime;
    }

    if (
      options.workspaceName === SOURCE_WORKSPACE_NAME &&
      options.projectPath === PROJECT_TWO_PATH
    ) {
      return projectTwoRuntime.runtime;
    }

    if (options.workspaceName === NEW_WORKSPACE_NAME && options.projectPath === PROJECT_ONE_PATH) {
      return targetProjectOneRuntime;
    }

    if (options.workspaceName === NEW_WORKSPACE_NAME && options.projectPath === PROJECT_TWO_PATH) {
      return targetProjectTwoRuntime;
    }

    throw new Error(
      `Unexpected createRuntime options: projectPath=${options.projectPath}, workspaceName=${options.workspaceName}`
    );
  });
}

describe("orchestrateFork (multi-project)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();

    applyForkRuntimeUpdatesMock = spyOn(
      runtimeUpdatesModule,
      "applyForkRuntimeUpdates"
    ).mockResolvedValue({
      forkedRuntimeConfig: SOURCE_RUNTIME_CONFIG,
    });

    createRuntimeMock = spyOn(runtimeFactoryModule, "createRuntime");

    createContainerMock = spyOn(ContainerManager.prototype, "createContainer").mockResolvedValue(
      CONTAINER_PATH
    );
    removeContainerMock = spyOn(ContainerManager.prototype, "removeContainer").mockResolvedValue();
    listLocalBranchesMock = spyOn(gitModule, "listLocalBranches").mockImplementation(() =>
      Promise.reject(new Error("git unavailable in test"))
    );
    detectDefaultTrunkBranchMock = spyOn(gitModule, "detectDefaultTrunkBranch").mockResolvedValue(
      "main"
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("fails closed before any project fork work when the multi-project experiment is disabled", async () => {
    const result = await runOrchestrateFork({
      parentMetadata: createParentMetadata(),
      multiProjectExperimentEnabled: false,
    });

    expect(result).toEqual({
      success: false,
      error:
        "Workspace workspace-parent reached multi-project fork orchestration while multi-project-workspaces is disabled",
    });
    expect(createRuntimeMock).not.toHaveBeenCalled();
    expect(createContainerMock).not.toHaveBeenCalled();
    expect(removeContainerMock).not.toHaveBeenCalled();
  });

  it("persists the primary git-root checkout while keeping runtime execution on the child container", async () => {
    const projectOneRuntime = createProjectRuntimeMocks();
    const projectTwoRuntime = createProjectRuntimeMocks();
    mockProjectRuntimes(projectOneRuntime, projectTwoRuntime);

    projectOneRuntime.forkWorkspace.mockResolvedValue({
      success: true,
      workspacePath: "/tmp/child/project-one",
      sourceBranch: "main",
    } satisfies WorkspaceForkResult);
    projectTwoRuntime.forkWorkspace.mockResolvedValue({
      success: true,
      workspacePath: "/tmp/child/project-two",
    } satisfies WorkspaceForkResult);

    const result = await runOrchestrateFork({
      parentMetadata: createParentMetadata(),
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error(`Expected success result, got error: ${result.error}`);

    expect(result.data.workspacePath).toBe("/tmp/child/project-one");
    // The non-primary checkouts, for task preparation to bind (proof v2).
    expect(result.data.secondaryCheckouts).toEqual([
      { projectPath: PROJECT_TWO_PATH, workspacePath: "/tmp/child/project-two" },
    ]);
    expect(result.data.trunkBranch).toBe("main");
    expect(result.data.forkedFromSource).toBe(true);
    expect(result.data.targetRuntime).toBeInstanceOf(MultiProjectRuntime);
    expect(result.data.targetRuntime.getWorkspacePath(PROJECT_ONE_PATH, NEW_WORKSPACE_NAME)).toBe(
      CONTAINER_PATH
    );

    expect(projectOneRuntime.forkWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPath: PROJECT_ONE_PATH,
        newWorkspaceName: NEW_WORKSPACE_NAME,
      })
    );
    expect(projectTwoRuntime.forkWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPath: PROJECT_TWO_PATH,
        newWorkspaceName: NEW_WORKSPACE_NAME,
      })
    );

    expect(createContainerMock).toHaveBeenCalledWith(NEW_WORKSPACE_NAME, [
      { projectName: "project-one", workspacePath: "/tmp/child/project-one" },
      { projectName: "project-two", workspacePath: "/tmp/child/project-two" },
    ]);
    expect(removeContainerMock).not.toHaveBeenCalled();

    expect(createRuntimeMock).toHaveBeenCalledTimes(4);
  });

  it("preserves pre-existing containers when createContainer fails with EEXIST", async () => {
    const projectOneRuntime = createProjectRuntimeMocks();
    const projectTwoRuntime = createProjectRuntimeMocks();
    mockProjectRuntimes(projectOneRuntime, projectTwoRuntime);

    projectOneRuntime.forkWorkspace.mockResolvedValue({
      success: true,
      workspacePath: "/tmp/child/project-one",
      sourceBranch: "main",
    } satisfies WorkspaceForkResult);
    projectTwoRuntime.forkWorkspace.mockResolvedValue({
      success: true,
      workspacePath: "/tmp/child/project-two",
    } satisfies WorkspaceForkResult);
    projectOneRuntime.deleteWorkspace.mockResolvedValue({ success: true });
    projectTwoRuntime.deleteWorkspace.mockResolvedValue({ success: true });
    createContainerMock.mockRejectedValueOnce(
      Object.assign(new Error(`${NEW_WORKSPACE_NAME} already exists`), { code: "EEXIST" })
    );

    const result = await runOrchestrateFork({
      parentMetadata: createParentMetadata(),
    });

    expect(result).toEqual({
      success: false,
      error: `Failed to create child workspace container: ${NEW_WORKSPACE_NAME} already exists`,
    });
    expect(createContainerMock).toHaveBeenCalledWith(NEW_WORKSPACE_NAME, [
      { projectName: "project-one", workspacePath: "/tmp/child/project-one" },
      { projectName: "project-two", workspacePath: "/tmp/child/project-two" },
    ]);
    expect(projectOneRuntime.deleteWorkspace).toHaveBeenCalledWith(
      PROJECT_ONE_PATH,
      NEW_WORKSPACE_NAME,
      false,
      undefined,
      true
    );
    expect(projectTwoRuntime.deleteWorkspace).toHaveBeenCalledWith(
      PROJECT_TWO_PATH,
      NEW_WORKSPACE_NAME,
      false,
      undefined,
      true
    );
    expect(removeContainerMock).not.toHaveBeenCalled();
  });

  it("returns the primary git-root when the primary project falls back to createWorkspace", async () => {
    const projectOneRuntime = createProjectRuntimeMocks();
    const projectTwoRuntime = createProjectRuntimeMocks();
    mockProjectRuntimes(projectOneRuntime, projectTwoRuntime);

    projectOneRuntime.forkWorkspace.mockResolvedValue({
      success: false,
      error: "fork unavailable",
    } satisfies WorkspaceForkResult);
    projectOneRuntime.createWorkspace.mockResolvedValue({
      success: true,
      workspacePath: "/tmp/child/project-one-created",
    });
    projectTwoRuntime.forkWorkspace.mockResolvedValue({
      success: true,
      workspacePath: "/tmp/child/project-two",
    } satisfies WorkspaceForkResult);

    const result = await runOrchestrateFork({
      parentMetadata: createParentMetadata(),
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error(`Expected success result, got error: ${result.error}`);

    expect(result.data.workspacePath).toBe("/tmp/child/project-one-created");
    expect(result.data.forkedFromSource).toBe(false);
    expect(result.data.targetRuntime.getWorkspacePath(PROJECT_ONE_PATH, NEW_WORKSPACE_NAME)).toBe(
      CONTAINER_PATH
    );
    expect(projectOneRuntime.createWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPath: PROJECT_ONE_PATH,
        trunkBranch: "main",
      })
    );
    expect(createContainerMock).toHaveBeenCalledWith(NEW_WORKSPACE_NAME, [
      { projectName: "project-one", workspacePath: "/tmp/child/project-one-created" },
      { projectName: "project-two", workspacePath: "/tmp/child/project-two" },
    ]);
  });

  it("resolves trust per project when forking multi-project workspaces", async () => {
    const projectOneRuntime = createProjectRuntimeMocks();
    const projectTwoRuntime = createProjectRuntimeMocks();
    mockProjectRuntimes(projectOneRuntime, projectTwoRuntime);

    projectOneRuntime.forkWorkspace.mockResolvedValue({
      success: true,
      workspacePath: "/tmp/child/project-one",
      sourceBranch: "main",
    } satisfies WorkspaceForkResult);
    projectTwoRuntime.forkWorkspace.mockResolvedValue({
      success: false,
      error: "fork unavailable",
    } satisfies WorkspaceForkResult);
    projectTwoRuntime.createWorkspace.mockResolvedValue({
      success: true,
      workspacePath: "/tmp/child/project-two",
    });

    const result = await runOrchestrateFork({
      parentMetadata: createParentMetadata(),
      config: createConfig({
        [PROJECT_ONE_PATH]: true,
        [PROJECT_TWO_PATH]: true,
      }),
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error(`Expected success result, got error: ${result.error}`);

    expect(result.data.workspacePath).toBe("/tmp/child/project-one");
    expect(result.data.targetRuntime.getWorkspacePath(PROJECT_ONE_PATH, NEW_WORKSPACE_NAME)).toBe(
      CONTAINER_PATH
    );
    expect(projectOneRuntime.forkWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ trusted: true })
    );
    expect(projectTwoRuntime.forkWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ trusted: true })
    );
    expect(projectTwoRuntime.createWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ trusted: true })
    );
  });

  it("fails multi-project fork before creating workspaces when any project is untrusted", async () => {
    const projectOneRuntime = createProjectRuntimeMocks();
    const projectTwoRuntime = createProjectRuntimeMocks();
    mockProjectRuntimes(projectOneRuntime, projectTwoRuntime);

    const result = await runOrchestrateFork({
      parentMetadata: createParentMetadata(),
      config: createConfig({
        [PROJECT_ONE_PATH]: true,
        [PROJECT_TWO_PATH]: false,
      }),
    });

    expect(result).toEqual({
      success: false,
      error: `Project ${PROJECT_TWO_PATH} is not trusted`,
    });
    expect(projectOneRuntime.forkWorkspace).not.toHaveBeenCalled();
    expect(projectTwoRuntime.forkWorkspace).not.toHaveBeenCalled();
    expect(projectOneRuntime.createWorkspace).not.toHaveBeenCalled();
    expect(projectTwoRuntime.createWorkspace).not.toHaveBeenCalled();
    expect(createContainerMock).not.toHaveBeenCalled();
    expect(removeContainerMock).not.toHaveBeenCalled();
    expect(applyForkRuntimeUpdatesMock).not.toHaveBeenCalled();
  });

  it("defaults unknown project trust to false during multi-project fork", async () => {
    const projectOneRuntime = createProjectRuntimeMocks();
    const projectTwoRuntime = createProjectRuntimeMocks();
    mockProjectRuntimes(projectOneRuntime, projectTwoRuntime);

    const result = await runOrchestrateFork({
      parentMetadata: createParentMetadata(),
      config: createConfig({
        [PROJECT_ONE_PATH]: true,
      }),
      trusted: true,
    });

    expect(result).toEqual({
      success: false,
      error: `Project ${PROJECT_TWO_PATH} is not trusted`,
    });
    expect(projectOneRuntime.forkWorkspace).not.toHaveBeenCalled();
    expect(projectTwoRuntime.forkWorkspace).not.toHaveBeenCalled();
    expect(projectOneRuntime.createWorkspace).not.toHaveBeenCalled();
    expect(projectTwoRuntime.createWorkspace).not.toHaveBeenCalled();
    expect(createContainerMock).not.toHaveBeenCalled();
    expect(removeContainerMock).not.toHaveBeenCalled();
    expect(applyForkRuntimeUpdatesMock).not.toHaveBeenCalled();
  });

  it("uses preferredTrunkBranch before local discovery for multi-project fallback", async () => {
    const projectOneRuntime = createProjectRuntimeMocks();
    const projectTwoRuntime = createProjectRuntimeMocks();
    mockProjectRuntimes(projectOneRuntime, projectTwoRuntime);

    projectOneRuntime.forkWorkspace.mockResolvedValue({
      success: true,
      workspacePath: "/tmp/child/project-one",
      sourceBranch: "main",
    } satisfies WorkspaceForkResult);
    projectTwoRuntime.forkWorkspace.mockResolvedValue({
      success: false,
      error: "fork unavailable",
    } satisfies WorkspaceForkResult);
    projectTwoRuntime.createWorkspace.mockResolvedValue({
      success: true,
      workspacePath: "/tmp/child/project-two",
    });

    // If fallback trunk resolution reaches local discovery, it would choose "master".
    listLocalBranchesMock.mockResolvedValue(["master", "feature-two"]);
    detectDefaultTrunkBranchMock.mockResolvedValue("master");

    const result = await runOrchestrateFork({
      parentMetadata: createParentMetadata(),
      preferredTrunkBranch: "develop",
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error(`Expected success result, got error: ${result.error}`);

    expect(projectTwoRuntime.createWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPath: PROJECT_TWO_PATH,
        trunkBranch: "develop",
      })
    );

    // The primary project keeps its source branch as the returned trunk branch.
    expect(result.data.trunkBranch).toBe("main");

    expect(listLocalBranchesMock).not.toHaveBeenCalled();
    expect(detectDefaultTrunkBranchMock).not.toHaveBeenCalled();
  });

  it("resolves fallback create trunk branch per project", async () => {
    const projectOneRuntime = createProjectRuntimeMocks();
    const projectTwoRuntime = createProjectRuntimeMocks();
    mockProjectRuntimes(projectOneRuntime, projectTwoRuntime);

    projectOneRuntime.forkWorkspace.mockResolvedValue({
      success: true,
      workspacePath: "/tmp/child/project-one",
      sourceBranch: "main",
    } satisfies WorkspaceForkResult);
    projectTwoRuntime.forkWorkspace.mockResolvedValue({
      success: false,
      error: "fork unavailable",
    } satisfies WorkspaceForkResult);
    projectTwoRuntime.createWorkspace.mockResolvedValue({
      success: true,
      workspacePath: "/tmp/child/project-two",
    });

    listLocalBranchesMock.mockImplementation((projectPath) => {
      if (projectPath === PROJECT_TWO_PATH) {
        return Promise.resolve(["master", "feature-two"]);
      }
      if (projectPath === PROJECT_ONE_PATH) {
        return Promise.resolve(["main", "feature-one"]);
      }
      throw new Error(`Unexpected project path for listLocalBranches: ${projectPath}`);
    });
    detectDefaultTrunkBranchMock.mockImplementation((projectPath, branches) => {
      if (projectPath === PROJECT_TWO_PATH) {
        return Promise.resolve("master");
      }
      return Promise.resolve(branches?.[0] ?? "main");
    });

    const result = await runOrchestrateFork({
      parentMetadata: createParentMetadata(),
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error(`Expected success result, got error: ${result.error}`);

    expect(projectTwoRuntime.createWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPath: PROJECT_TWO_PATH,
        trunkBranch: "master",
      })
    );
    expect(detectDefaultTrunkBranchMock).toHaveBeenCalledWith(PROJECT_TWO_PATH, [
      "master",
      "feature-two",
    ]);
    expect(result.data.trunkBranch).toBe("main");
  });
  it("inherits the parent projects array for child metadata", async () => {
    const projectOneRuntime = createProjectRuntimeMocks();
    const projectTwoRuntime = createProjectRuntimeMocks();
    mockProjectRuntimes(projectOneRuntime, projectTwoRuntime);

    projectOneRuntime.forkWorkspace.mockResolvedValue({
      success: true,
      workspacePath: "/tmp/child/project-one",
      sourceBranch: "develop",
    } satisfies WorkspaceForkResult);
    projectTwoRuntime.forkWorkspace.mockResolvedValue({
      success: true,
      workspacePath: "/tmp/child/project-two",
    } satisfies WorkspaceForkResult);

    const parentMetadata = createParentMetadata();
    const result = await runOrchestrateFork({ parentMetadata });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error(`Expected success result, got error: ${result.error}`);

    expect(result.data.projects).toEqual(parentMetadata.projects);
  });

  it("rolls back already-forked projects when a later project fork fails", async () => {
    const projectOneRuntime = createProjectRuntimeMocks();
    const projectTwoRuntime = createProjectRuntimeMocks();
    mockProjectRuntimes(projectOneRuntime, projectTwoRuntime);

    projectOneRuntime.forkWorkspace.mockResolvedValue({
      success: true,
      workspacePath: "/tmp/child/project-one",
      sourceBranch: "main",
    } satisfies WorkspaceForkResult);
    projectOneRuntime.deleteWorkspace.mockResolvedValue({
      success: true,
      deletedPath: "/tmp/child/project-one",
    });

    projectTwoRuntime.forkWorkspace.mockResolvedValue({
      success: false,
      error: "second project fork failed",
    } satisfies WorkspaceForkResult);

    const result = await orchestrateFork({
      sourceRuntime: createProjectRuntimeMocks().runtime,
      projectPath: PROJECT_ONE_PATH,
      sourceWorkspaceName: SOURCE_WORKSPACE_NAME,
      newWorkspaceName: NEW_WORKSPACE_NAME,
      initLogger: createInitLogger(),
      config: createConfig({
        [PROJECT_ONE_PATH]: true,
        [PROJECT_TWO_PATH]: true,
      }),
      sourceWorkspaceId: SOURCE_WORKSPACE_ID,
      sourceRuntimeConfig: SOURCE_RUNTIME_CONFIG,
      parentMetadata: createParentMetadata(),
      allowCreateFallback: false,
      multiProjectExperimentEnabled: true,
    });

    expect(result).toEqual({
      success: false,
      error: "Failed to fork project project-two: second project fork failed",
    });

    expect(projectOneRuntime.deleteWorkspace).toHaveBeenCalledWith(
      PROJECT_ONE_PATH,
      NEW_WORKSPACE_NAME,
      false,
      undefined,
      true
    );
    expect(projectTwoRuntime.deleteWorkspace).not.toHaveBeenCalled();
    expect(createContainerMock).not.toHaveBeenCalled();
    expect(createRuntimeMock).toHaveBeenCalledTimes(2);
    expect(applyForkRuntimeUpdatesMock).toHaveBeenCalledTimes(1);
  });
});
