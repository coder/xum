import { describe, expect, test, mock, beforeEach, afterEach, spyOn, type Mock } from "bun:test";
import type { WorkspaceService } from "./workspaceService";
import path from "path";
import { Err, Ok, type Result } from "@/common/types/result";
import type { InitStateManager } from "./initStateManager";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import { MULTI_PROJECT_CONFIG_KEY } from "@/common/constants/multiProject";
import type { ExperimentsService } from "@/node/services/experimentsService";
import type { RuntimeConfig } from "@/common/types/runtime";
import type { BashToolResult } from "@/common/types/tools";
import * as runtimeFactory from "@/node/runtime/runtimeFactory";
import * as bashToolModule from "@/node/services/tools/bash";
import * as runtimeExecHelpers from "@/node/utils/runtime/helpers";
import {
  addToArchivingWorkspaces,
  createMockAIService,
  createWorkspaceServiceHarness,
  type WorkspaceServiceHarness,
} from "./workspaceService.testHarness";

describe("WorkspaceService executeBash archive guards", () => {
  let harness: WorkspaceServiceHarness;
  let workspaceService: WorkspaceService;
  let waitForInitMock: Mock<InitStateManager["waitForInit"]>;
  let getWorkspaceMetadataMock: ReturnType<typeof mock>;

  beforeEach(async () => {
    getWorkspaceMetadataMock = mock(() =>
      Promise.resolve({ success: false as const, error: "not found" })
    );
    harness = await createWorkspaceServiceHarness({
      aiService: createMockAIService({
        isStreaming: mock(() => false),
        getWorkspaceMetadata: getWorkspaceMetadataMock,
      }),
    });
    workspaceService = harness.service;
    // Real init manager (no init state, so waits resolve at once); the spy records whether
    // executeBash reached init at all.
    waitForInitMock = spyOn(harness.initStateManager, "waitForInit");
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  test("archived workspace => executeBash returns error mentioning archived", async () => {
    const workspaceId = "ws-archived";

    const archivedMetadata: WorkspaceMetadata = {
      id: workspaceId,
      name: "ws",
      projectName: "proj",
      projectPath: "/tmp/proj",
      runtimeConfig: { type: "local", srcBaseDir: "/tmp" },
      archivedAt: "2026-01-01T00:00:00.000Z",
    };

    getWorkspaceMetadataMock.mockReturnValue(Promise.resolve(Ok(archivedMetadata)));

    const result = await workspaceService.executeBash(workspaceId, "echo hello");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("archived");
    }

    // This must happen before init/runtime operations.
    expect(waitForInitMock).toHaveBeenCalledTimes(0);
  });

  test("archiving workspace => executeBash returns error mentioning being archived", async () => {
    const workspaceId = "ws-archiving";

    addToArchivingWorkspaces(workspaceService, workspaceId);

    const result = await workspaceService.executeBash(workspaceId, "echo hello");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("being archived");
    }

    expect(waitForInitMock).toHaveBeenCalledTimes(0);
    expect(getWorkspaceMetadataMock).toHaveBeenCalledTimes(0);
  });

  test("in-flight executeBash holds the archive gate until it settles", async () => {
    const workspaceId = "ws-exec-pairing";

    // Park executeBash at its first await (metadata fetch): the admission was counted in its
    // synchronous entry block, so the archive gate must observe it with no timing games.
    let releaseMetadata: () => void = () => undefined;
    const metadataGate = new Promise<{ success: false; error: string }>((resolve) => {
      releaseMetadata = () => resolve({ success: false, error: "metadata unavailable (test)" });
    });
    getWorkspaceMetadataMock.mockReturnValue(metadataGate);

    const execPromise = workspaceService.executeBash(workspaceId, "echo hello");

    const archiveResult = await workspaceService.archive(workspaceId, undefined, {
      refuseLiveUserActivity: true,
    });
    expect(archiveResult.success).toBe(false);
    if (!archiveResult.success) {
      expect(archiveResult.error).toContain("bash command");
    }

    releaseMetadata();
    const execResult = await execPromise;
    expect(execResult.success).toBe(false);

    // Once the exec settled, its admission is released and the gate no longer reports it.
    const archiveAfter = await workspaceService.archive(workspaceId, undefined, {
      refuseLiveUserActivity: true,
    });
    if (!archiveAfter.success) {
      expect(archiveAfter.error).not.toContain("bash command");
    }
  });

  test("stageAttachment refuses while the workspace is being archived", async () => {
    addToArchivingWorkspaces(workspaceService, "ws-staging");

    const result = await workspaceService.stageAttachment({
      workspaceId: "ws-staging",
      filename: "notes.txt",
      sizeBytes: 1,
      dataBase64: Buffer.from("x").toString("base64"),
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("being archived");
    }
  });

  test("downloadStagedAttachment refuses while the workspace is being archived", async () => {
    // Downloads read from the checkout through the runtime (and can restart a stopped Coder
    // workspace), so they pair with the archive gates exactly like staging.
    addToArchivingWorkspaces(workspaceService, "ws-download");

    const result = await workspaceService.downloadStagedAttachment({
      workspaceId: "ws-download",
      stagedPath: ".xum/user-attachments/notes.txt",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("being archived");
    }
  });

  test("getFileCompletions returns empty without touching the workspace while archiving", async () => {
    addToArchivingWorkspaces(workspaceService, "ws-completions");

    // The sync entry guard must return before getInfo reads workspace metadata.
    const metadataSpy = spyOn(harness.config, "getAllWorkspaceMetadata");
    const result = await workspaceService.getFileCompletions("ws-completions", "src");

    expect(result.paths).toEqual([]);
    expect(metadataSpy).not.toHaveBeenCalled();
  });

  test("in-flight staging and completion refreshes hold the archive gate", async () => {
    // Park both requests at getInfo: their admissions were counted in the synchronous entry
    // blocks, so the archive gate observes them with no timing assumptions.
    let releaseMetadata: () => void = () => undefined;
    const metadataGate = new Promise<never[]>((resolve) => {
      releaseMetadata = () => resolve([]);
    });
    spyOn(harness.config, "getAllWorkspaceMetadata").mockReturnValue(metadataGate);

    const stagePromise = workspaceService.stageAttachment({
      workspaceId: "ws-gate",
      filename: "notes.txt",
      sizeBytes: 1,
      dataBase64: Buffer.from("x").toString("base64"),
    });
    const completionsPromise = workspaceService.getFileCompletions("ws-gate", "src");

    const archiveResult = await workspaceService.archive("ws-gate", undefined, {
      refuseLiveUserActivity: true,
    });
    expect(archiveResult.success).toBe(false);
    if (!archiveResult.success) {
      expect(archiveResult.error).toContain("an attachment transfer in progress");
      expect(archiveResult.error).toContain("a file completion refresh in progress");
    }

    releaseMetadata();
    const staged = await stagePromise;
    expect(staged.success).toBe(false); // Workspace not found in the empty metadata list.
    const completions = await completionsPromise;
    expect(completions.paths).toEqual([]);
  });
});

describe("WorkspaceService executeBash workspace path resolution", () => {
  let harness: WorkspaceServiceHarness;
  let workspaceService: WorkspaceService;
  let waitForInitMock: Mock<InitStateManager["waitForInit"]>;
  let getWorkspaceMetadataMock: ReturnType<typeof mock>;
  let createRuntimeSpy: Mock<typeof runtimeFactory.createRuntime>;
  let createBashToolSpy: Mock<typeof bashToolModule.createBashTool>;

  beforeEach(async () => {
    const metadata = {
      id: "ws-path",
      name: "ws",
      projectName: "proj",
      projectPath: "/tmp/proj",
      runtimeConfig: { type: "worktree", srcBaseDir: "/tmp/runtime-src" },
    } satisfies WorkspaceMetadata;
    getWorkspaceMetadataMock = mock(() => Promise.resolve(Ok(metadata)));
    harness = await createWorkspaceServiceHarness({
      aiService: createMockAIService({
        isStreaming: mock(() => false),
        getWorkspaceMetadata: getWorkspaceMetadataMock,
      }),
    });
    workspaceService = harness.service;
    waitForInitMock = spyOn(harness.initStateManager, "waitForInit");
    // The persisted checkout root differs from where the runtime would derive it.
    await harness.config.addWorkspace("/tmp/proj", {
      ...metadata,
      namedWorkspacePath: "/persisted/workspace-root",
    });

    createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue({
      ensureReady: mock(() => Promise.resolve({ ready: true })),
      getWorkspacePath: mock(() => "/runtime/workspace-root"),
      normalizePath: mock((targetPath: string, basePath: string) =>
        targetPath ? `${basePath}/${targetPath}` : basePath
      ),
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>);

    createBashToolSpy = spyOn(bashToolModule, "createBashTool").mockReturnValue({
      execute: mock(() =>
        Promise.resolve({
          success: true,
          output: "ok",
          exitCode: 0,
          wall_duration_ms: 1,
        } satisfies BashToolResult)
      ),
    } as unknown as ReturnType<typeof bashToolModule.createBashTool>);
  });

  afterEach(async () => {
    createRuntimeSpy.mockRestore();
    createBashToolSpy.mockRestore();
    await harness.cleanup();
  });

  test("uses persisted workspace root for path-addressable runtimes", async () => {
    const result = await workspaceService.executeBash("ws-path", "pwd");

    expect(result.success).toBe(true);
    expect(createRuntimeSpy).toHaveBeenCalled();
    expect(createBashToolSpy).toHaveBeenCalledTimes(1);
    expect(createBashToolSpy.mock.calls[0]?.[0]?.cwd).toBe("/persisted/workspace-root");
    expect(waitForInitMock).toHaveBeenCalledWith("ws-path");
  });

  test("keeps default sub-project execution in the sub-project but runs repo-root mode at checkout root", async () => {
    getWorkspaceMetadataMock.mockReturnValue(
      Promise.resolve(
        Ok({
          id: "ws-path",
          name: "ws",
          projectName: "proj",
          projectPath: "/tmp/proj",
          subProjectPath: "/tmp/proj/packages/api",
          runtimeConfig: { type: "worktree", srcBaseDir: "/tmp/runtime-src" },
        } satisfies WorkspaceMetadata)
      )
    );

    const defaultResult = await workspaceService.executeBash("ws-path", "pwd");
    const repoRootResult = await workspaceService.executeBash("ws-path", "git diff", {
      cwdMode: "repo-root",
    });
    const gitCommandResult = await workspaceService.executeBash("ws-path", "", undefined, "git", [
      "status",
    ]);

    expect(defaultResult.success).toBe(true);
    expect(repoRootResult.success).toBe(true);
    expect(gitCommandResult.success).toBe(true);
    expect(createBashToolSpy).toHaveBeenCalledTimes(3);
    expect(createBashToolSpy.mock.calls[0]?.[0]?.cwd).toBe(
      "/persisted/workspace-root/packages/api"
    );
    expect(createBashToolSpy.mock.calls[1]?.[0]?.cwd).toBe("/persisted/workspace-root");
    expect(createBashToolSpy.mock.calls[2]?.[0]?.cwd).toBe("/persisted/workspace-root");
  });

  test("keeps docker executeBash rooted in the translated runtime path", async () => {
    getWorkspaceMetadataMock.mockReturnValue(
      Promise.resolve(
        Ok({
          id: "ws-path",
          name: "ws",
          projectName: "proj",
          projectPath: "/tmp/proj",
          runtimeConfig: { type: "docker", image: "node:20" },
        } satisfies WorkspaceMetadata)
      )
    );

    const result = await workspaceService.executeBash("ws-path", "pwd");

    expect(result.success).toBe(true);
    expect(createBashToolSpy).toHaveBeenCalledTimes(1);
    expect(createBashToolSpy.mock.calls[0]?.[0]?.cwd).toBe("/runtime/workspace-root");
  });
});

describe("WorkspaceService getFileCompletions", () => {
  let harness: WorkspaceServiceHarness;
  let workspaceService: WorkspaceService;
  let createRuntimeSpy: Mock<typeof runtimeFactory.createRuntime>;
  let execBufferedSpy: Mock<typeof runtimeExecHelpers.execBuffered>;

  /** Persist a two-repo workspace the way multi-project creation does (shared config key). */
  async function registerMultiProjectWorkspace(entry: {
    id: string;
    path: string;
    runtimeConfig: RuntimeConfig;
  }): Promise<void> {
    await harness.config.editConfig((cfg) => {
      cfg.projects.set(MULTI_PROJECT_CONFIG_KEY, {
        workspaces: [
          {
            ...entry,
            name: "ws",
            projects: [
              { projectPath: "/tmp/project-a", projectName: "project-a" },
              { projectPath: "/tmp/project-b", projectName: "project-b" },
            ],
          },
        ],
      });
      return cfg;
    });
  }

  beforeEach(async () => {
    harness = await createWorkspaceServiceHarness({
      aiService: createMockAIService({ isStreaming: mock(() => false) }),
      // Multi-project workspaces are hidden from getInfo unless the experiment is on.
      experimentsService: {
        isExperimentEnabled: mock(() => true),
      } as unknown as ExperimentsService,
    });
    workspaceService = harness.service;

    createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockImplementation(
      (_runtimeConfig, options) => {
        if (!options?.projectPath) {
          throw new Error("Expected createRuntime projectPath in getFileCompletions test");
        }
        const runtimeProjectPath = options.projectPath;

        return {
          getWorkspacePath: (_projectPath: string, workspaceName: string) =>
            `/runtime/${path.basename(runtimeProjectPath)}/${workspaceName}`,
        } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;
      }
    );

    execBufferedSpy = spyOn(runtimeExecHelpers, "execBuffered").mockImplementation(
      (_runtime, _command, options) =>
        Promise.reject(new Error(`Unexpected execBuffered call for ${options.cwd}`))
    );
  });

  afterEach(async () => {
    createRuntimeSpy.mockRestore();
    execBufferedSpy.mockRestore();
    await harness.cleanup();
  });

  test("keeps single-project completions unchanged", async () => {
    // Registered in the real Config, which getInfo reads.
    await harness.config.addWorkspace("/tmp/project-a", {
      id: "ws-single",
      name: "ws",
      projectName: "project-a",
      projectPath: "/tmp/project-a",
      namedWorkspacePath: "/persisted/project-a/ws",
      runtimeConfig: { type: "worktree", srcBaseDir: "/tmp/src" },
    });

    execBufferedSpy.mockResolvedValue({
      stdout: "src/single.ts\n",
      stderr: "",
      exitCode: 0,
      duration: 1,
    });

    const result = await workspaceService.getFileCompletions("ws-single", "src/");

    expect(result.paths).toEqual(["src/single.ts"]);
    expect(execBufferedSpy).toHaveBeenCalledTimes(1);
    expect(execBufferedSpy.mock.calls[0]?.[2].cwd).toBe("/persisted/project-a/ws");
  });

  test("preserves the current SSH workspace path and derives sibling legacy paths for multi-project completions when the persisted root matches that layout", async () => {
    await registerMultiProjectWorkspace({
      id: "ws-multi-ssh",
      path: "/tmp/src/project-a/ws",
      runtimeConfig: { type: "ssh", host: "example.com", srcBaseDir: "/tmp/src" },
    });
    createRuntimeSpy.mockImplementation((_runtimeConfig, options) => {
      const runtimeProjectPath = options?.projectPath;
      if (!runtimeProjectPath) {
        throw new Error("Expected createRuntime projectPath in SSH completion test");
      }
      return {
        getWorkspacePath: () =>
          options.workspacePath ?? `/runtime/${path.basename(runtimeProjectPath)}/ws`,
      } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;
    });

    execBufferedSpy.mockImplementation((_runtime, _command, options) => {
      if (options.cwd === "/tmp/src/project-a/ws") {
        return Promise.resolve({
          stdout: "README.md\n",
          stderr: "",
          exitCode: 0,
          duration: 1,
        });
      }
      if (options.cwd === "/tmp/src/project-b/ws") {
        return Promise.resolve({
          stdout: "src/b.ts\n",
          stderr: "",
          exitCode: 0,
          duration: 1,
        });
      }
      return Promise.reject(new Error(`Unexpected cwd ${options.cwd}`));
    });

    const result = await workspaceService.getFileCompletions("ws-multi-ssh", "", 10);

    expect(result.paths).toContain("project-a/README.md");
    expect(result.paths).toContain("project-b/src/b.ts");
    expect(createRuntimeSpy).toHaveBeenNthCalledWith(1, expect.anything(), {
      projectPath: "/tmp/project-a",
      workspaceName: "ws",
      workspacePath: "/tmp/src/project-a/ws",
    });
    expect(createRuntimeSpy).toHaveBeenNthCalledWith(2, expect.anything(), {
      projectPath: "/tmp/project-b",
      workspaceName: "ws",
      workspacePath: "/tmp/src/project-b/ws",
    });
  });

  test("aggregates multi-project completions using project-prefixed paths", async () => {
    await registerMultiProjectWorkspace({
      id: "ws-multi",
      path: "/persisted/container/ws",
      runtimeConfig: { type: "worktree", srcBaseDir: "/tmp/src" },
    });

    execBufferedSpy.mockImplementation((_runtime, _command, options) => {
      if (options.cwd === "/runtime/project-a/ws") {
        return Promise.resolve({
          stdout: "README.md\nsrc/a.ts\n",
          stderr: "",
          exitCode: 0,
          duration: 1,
        });
      }

      if (options.cwd === "/runtime/project-b/ws") {
        return Promise.resolve({
          stdout: "src/b.ts\nnested/keep.ts\n",
          stderr: "",
          exitCode: 0,
          duration: 1,
        });
      }

      return Promise.reject(new Error(`Unexpected cwd ${options.cwd}`));
    });

    const result = await workspaceService.getFileCompletions("ws-multi", "", 10);

    expect(result.paths).toContain("project-a/README.md");
    expect(result.paths).toContain("project-a/src/a.ts");
    expect(result.paths).toContain("project-b/src/b.ts");
    expect(result.paths).toContain("project-b/nested/keep.ts");
    expect(result.paths).not.toContain("src/a.ts");
    expect(result.paths).toHaveLength(4);

    const completionCwds = execBufferedSpy.mock.calls
      .map((call) => call[2].cwd)
      .sort((left, right) => left.localeCompare(right));
    expect(completionCwds).toEqual(["/runtime/project-a/ws", "/runtime/project-b/ws"]);
  });
});

describe("WorkspaceService getProjectGitStatuses", () => {
  const harnesses: WorkspaceServiceHarness[] = [];

  afterEach(async () => {
    for (const harness of harnesses.splice(0)) {
      await harness.cleanup();
    }
  });

  function createGitStatusOutput(params?: {
    headBranch?: string;
    primaryBranch?: string;
    ahead?: number;
    behind?: number;
    dirtyCount?: number;
    outgoingAdditions?: number;
    outgoingDeletions?: number;
    incomingAdditions?: number;
    incomingDeletions?: number;
  }): string {
    return [
      "---HEAD_BRANCH---",
      params?.headBranch ?? "feature/test",
      "---PRIMARY---",
      params?.primaryBranch ?? "main",
      "---AHEAD_BEHIND---",
      `${params?.ahead ?? 1} ${params?.behind ?? 0}`,
      "---DIRTY---",
      String(params?.dirtyCount ?? 0),
      "---LINE_DELTA---",
      `${params?.outgoingAdditions ?? 5} ${params?.outgoingDeletions ?? 2} ${params?.incomingAdditions ?? 3} ${params?.incomingDeletions ?? 1}`,
      "",
    ].join("\n");
  }

  function bashOk(output: string): Result<BashToolResult> {
    return {
      success: true,
      data: {
        success: true,
        output,
        exitCode: 0,
        wall_duration_ms: 0,
      },
    };
  }

  async function createServiceHarness(params: {
    metadata: WorkspaceMetadata;
    executeBashImpl: (
      workspaceId: string,
      script: string,
      options?: {
        timeout_secs?: number | null;
        cwdMode?: "default" | "repo-root" | null;
        repoRootProjectPath?: string | null;
      }
    ) => Promise<Result<BashToolResult>>;
  }): Promise<{
    workspaceService: WorkspaceService;
    executeBashMock: ReturnType<typeof mock>;
    getWorkspaceMetadataMock: ReturnType<typeof mock>;
  }> {
    const getWorkspaceMetadataMock = mock(() => Promise.resolve(Ok(params.metadata)));
    const harness = await createWorkspaceServiceHarness({
      aiService: createMockAIService({
        isStreaming: mock(() => false),
        getWorkspaceMetadata: getWorkspaceMetadataMock,
      }),
    });
    harnesses.push(harness);
    const workspaceService = harness.service;

    const executeBashMock = mock(params.executeBashImpl);

    interface WorkspaceServiceTestAccess {
      executeBash: typeof executeBashMock;
    }

    const svc = workspaceService as unknown as WorkspaceServiceTestAccess;
    svc.executeBash = executeBashMock;

    return { workspaceService, executeBashMock, getWorkspaceMetadataMock };
  }

  test("returns no entries for scratch workspaces without invoking git", async () => {
    const metadata: WorkspaceMetadata = {
      kind: "scratch",
      id: "ws-scratch",
      name: "scratch-ws-scratch",
      projectName: "Scratch",
      projectPath: "/tmp/mux/scratch/ws-scratch",
      runtimeConfig: { type: "local" },
    };
    const { workspaceService, executeBashMock } = await createServiceHarness({
      metadata,
      executeBashImpl: () => Promise.reject(new Error("git should not run")),
    });

    expect(await workspaceService.getProjectGitStatuses(metadata.id)).toEqual([]);
    expect(executeBashMock).not.toHaveBeenCalled();
  });

  test("returns a single entry for single-project workspaces", async () => {
    const metadata: WorkspaceMetadata = {
      id: "ws-single",
      name: "ws-single",
      projectName: "project-a",
      projectPath: "/tmp/project-a",
      runtimeConfig: { type: "local" },
    };

    const { workspaceService, executeBashMock, getWorkspaceMetadataMock } =
      await createServiceHarness({
        metadata,
        executeBashImpl: () => Promise.resolve(bashOk(createGitStatusOutput({ dirtyCount: 2 }))),
      });

    const result = await workspaceService.getProjectGitStatuses(metadata.id);

    expect(result).toEqual([
      {
        projectPath: "/tmp/project-a",
        projectName: "project-a",
        gitStatus: {
          branch: "feature/test",
          ahead: 1,
          behind: 0,
          dirty: true,
          outgoingAdditions: 5,
          outgoingDeletions: 2,
          incomingAdditions: 3,
          incomingDeletions: 1,
        },
        error: null,
      },
    ]);
    expect(getWorkspaceMetadataMock).toHaveBeenCalledWith(metadata.id);
    expect(executeBashMock).toHaveBeenCalledTimes(1);
    expect(executeBashMock).toHaveBeenNthCalledWith(
      1,
      metadata.id,
      expect.stringContaining("PREFERRED_BRANCH=''"),
      expect.objectContaining({
        cwdMode: "repo-root",
        repoRootProjectPath: "/tmp/project-a",
        timeout_secs: 5,
      })
    );
    expect(executeBashMock.mock.calls.some(([, script]) => script === "git fetch --quiet")).toBe(
      false
    );
  });

  test("returns one entry per project in stable order for multi-project workspaces", async () => {
    const metadata: WorkspaceMetadata = {
      id: "ws-multi",
      name: "ws-multi",
      projectName: "project-a",
      projectPath: "/tmp/project-a",
      runtimeConfig: { type: "local" },
      projects: [
        { projectPath: "/tmp/project-a", projectName: "project-a" },
        { projectPath: "/tmp/project-b", projectName: "project-b" },
      ],
    };

    const { workspaceService, executeBashMock } = await createServiceHarness({
      metadata,
      executeBashImpl: (_workspaceId, _script, options) => {
        const repoRootProjectPath = options?.repoRootProjectPath;
        if (repoRootProjectPath === "/tmp/project-a") {
          return Promise.resolve(
            bashOk(createGitStatusOutput({ headBranch: "feature/a", ahead: 2 }))
          );
        }
        if (repoRootProjectPath === "/tmp/project-b") {
          return Promise.resolve(
            bashOk(createGitStatusOutput({ headBranch: "feature/b", behind: 3 }))
          );
        }
        throw new Error(`Unexpected repoRootProjectPath: ${String(repoRootProjectPath)}`);
      },
    });

    const result = await workspaceService.getProjectGitStatuses(metadata.id, "origin/release");

    expect(result.map((entry) => entry.projectName)).toEqual(["project-a", "project-b"]);
    expect(result[0]?.gitStatus?.branch).toBe("feature/a");
    expect(result[0]?.gitStatus?.ahead).toBe(2);
    expect(result[1]?.gitStatus?.branch).toBe("feature/b");
    expect(result[1]?.gitStatus?.behind).toBe(3);
    expect(executeBashMock).toHaveBeenCalledTimes(2);
    expect(executeBashMock).toHaveBeenNthCalledWith(
      1,
      metadata.id,
      expect.stringContaining("PREFERRED_BRANCH='release'"),
      expect.objectContaining({ repoRootProjectPath: "/tmp/project-a", timeout_secs: 5 })
    );
    expect(executeBashMock).toHaveBeenNthCalledWith(
      2,
      metadata.id,
      expect.stringContaining("PREFERRED_BRANCH='release'"),
      expect.objectContaining({ repoRootProjectPath: "/tmp/project-b", timeout_secs: 5 })
    );
    expect(executeBashMock.mock.calls.some(([, script]) => script === "git fetch --quiet")).toBe(
      false
    );
  });

  test("continues when one project bash execution fails", async () => {
    const metadata: WorkspaceMetadata = {
      id: "ws-multi-failure",
      name: "ws-multi-failure",
      projectName: "project-a",
      projectPath: "/tmp/project-a",
      runtimeConfig: { type: "local" },
      projects: [
        { projectPath: "/tmp/project-a", projectName: "project-a" },
        { projectPath: "/tmp/project-b", projectName: "project-b" },
      ],
    };

    const { workspaceService } = await createServiceHarness({
      metadata,
      executeBashImpl: (_workspaceId, _script, options) => {
        if (options?.repoRootProjectPath === "/tmp/project-a") {
          return Promise.resolve(bashOk(createGitStatusOutput()));
        }
        return Promise.resolve(Err("git failed for project-b"));
      },
    });

    const result = await workspaceService.getProjectGitStatuses(metadata.id);

    expect(result).toEqual([
      {
        projectPath: "/tmp/project-a",
        projectName: "project-a",
        gitStatus: {
          branch: "feature/test",
          ahead: 1,
          behind: 0,
          dirty: false,
          outgoingAdditions: 5,
          outgoingDeletions: 2,
          incomingAdditions: 3,
          incomingDeletions: 1,
        },
        error: null,
      },
      {
        projectPath: "/tmp/project-b",
        projectName: "project-b",
        gitStatus: null,
        error: "git failed for project-b",
      },
    ]);
  });

  test("returns gitStatus null with an error when output cannot be parsed", async () => {
    const metadata: WorkspaceMetadata = {
      id: "ws-unparsable",
      name: "ws-unparsable",
      projectName: "project-a",
      projectPath: "/tmp/project-a",
      runtimeConfig: { type: "local" },
    };

    const { workspaceService } = await createServiceHarness({
      metadata,
      executeBashImpl: () => Promise.resolve(bashOk("definitely not git status output")),
    });

    const result = await workspaceService.getProjectGitStatuses(metadata.id);

    expect(result).toEqual([
      {
        projectPath: "/tmp/project-a",
        projectName: "project-a",
        gitStatus: null,
        error: "Failed to parse git status script output",
      },
    ]);
  });
});
