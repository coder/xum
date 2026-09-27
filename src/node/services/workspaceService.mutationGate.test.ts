import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
import * as path from "path";
import * as readline from "node:readline";

import type { Config, Workspace as WorkspaceConfigEntry } from "@/node/config";
import { Err, Ok } from "@/common/types/result";
import type { Runtime, WorkspaceInitParams } from "@/node/runtime/Runtime";
import * as runtimeFactory from "@/node/runtime/runtimeFactory";
import { HistoryService } from "@/node/services/historyService";
import {
  createTestConfig,
  createTestProject,
  findWorkspaceInConfig,
  projectWorkspace,
  saveWorkspaces,
  testTaskSettings,
} from "@/node/services/taskService.testHarness";
import { findWorkspaceEntry } from "@/node/services/taskUtils";
import * as bashToolModule from "@/node/services/tools/bash";
import { createTestHistoryService } from "@/node/services/testHistoryService";
import { WorkspaceLifecycleHooks } from "@/node/services/workspaceLifecycleHooks";
import type { WorkspaceService } from "@/node/services/workspaceService";
import {
  createMockAIService,
  createWorkspaceServiceForTest,
} from "@/node/services/workspaceService.testHarness";
import {
  workspaceUseLeasesFor,
  type WorkspaceUseKind,
  type WorkspaceUseLease,
} from "@/node/services/workspaceUseLeases";
import * as removeManagedWorktree from "@/node/worktree/removeManagedGitWorktree";

// #4476: two backends on one Xum root (the desktop app beside a `xum server`) may both use one
// workspace. A structural mutation by one must refuse, without waiting, while the other has a
// turn, terminal or background process in the workspace or in a sub-agent sharing its checkout.

const rootId = "root-gate";
const sharedChildId = "shared-child-gate";
const inUseElsewhere = "in use by another Xum process";

interface Backend {
  config: Config;
  workspaceService: WorkspaceService;
}

function createBackend(config: Config, historyService: HistoryService): Backend {
  // Metadata is answered from this backend's Config, as AIService does.
  const aiService = createMockAIService({
    getWorkspaceMetadata: mock(async (workspaceId: string) => {
      const metadata = await config.getWorkspaceMetadataById(workspaceId);
      return metadata ? Ok(metadata) : Err(`Workspace metadata not found for ${workspaceId}`);
    }),
  });
  const workspaceService = createWorkspaceServiceForTest({ config, historyService, aiService });
  // Registered (even empty) hooks make archive read the metadata that decides checkout deletion.
  workspaceService.setWorkspaceLifecycleHooks(new WorkspaceLifecycleHooks());
  return { config, workspaceService };
}

function rowOf(config: Config, id: string): WorkspaceConfigEntry | undefined {
  return findWorkspaceInConfig(config, id);
}

describe("structural workspace mutations across two backends on one root", () => {
  let cleanupFixture: () => Promise<void>;
  let projectPath: string;
  let srcBaseDir: string;
  let a: Backend;
  let b: Backend;
  let renameWorkspace: ReturnType<typeof mock>;
  let deleteWorkspace: ReturnType<typeof mock>;
  let ensureReady: ReturnType<typeof mock>;
  const leases: WorkspaceUseLease[] = [];

  beforeEach(async () => {
    const fixture = await createTestHistoryService();
    cleanupFixture = fixture.cleanup;
    projectPath = await createTestProject(fixture.tempDir, "repo", { initGit: false });
    srcBaseDir = path.join(fixture.tempDir, "src");
    await saveWorkspaces(
      fixture.config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootId, {
          runtimeConfig: { type: "worktree", srcBaseDir },
        }),
      ],
      testTaskSettings()
    );
    a = createBackend(fixture.config, fixture.historyService);
    const configB = await createTestConfig(fixture.tempDir);
    b = createBackend(configB, new HistoryService(configB));
    // The checkout move and deletion are the structural effects every test watches.
    renameWorkspace = mock(() => Promise.resolve({ success: false as const, error: "stub move" }));
    deleteWorkspace = mock(() => Promise.resolve({ success: true as const, deletedPath: "x" }));
    ensureReady = mock(() => Promise.resolve({ ready: false, error: "stub runtime" }));
    spyOn(runtimeFactory, "createRuntime").mockReturnValue({
      renameWorkspace,
      deleteWorkspace,
      ensureReady,
      getWorkspacePath: () => path.join(srcBaseDir, "repo", "root"),
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>);
  });

  afterEach(async () => {
    for (const lease of leases.splice(0)) await lease.release();
    mock.restore();
    await cleanupFixture();
  });

  async function hold(backend: Backend, id: string, kind: WorkspaceUseKind): Promise<void> {
    leases.push(await workspaceUseLeasesFor(backend.config).hold(id, kind));
  }

  async function releaseAll(): Promise<void> {
    for (const lease of leases.splice(0)) await lease.release();
  }

  async function editRow(id: string, edit: (row: WorkspaceConfigEntry) => void): Promise<void> {
    await a.config.editConfig((config) => {
      edit(findWorkspaceEntry(config, id)!.workspace);
      return config;
    });
  }

  function errorOf(result: { success: boolean; error?: unknown }): string {
    expect(result.success).toBe(false);
    return String(result.error);
  }

  test("rename refuses while the other backend has a turn in the workspace, and runs after it ends", async () => {
    await hold(b, rootId, "turn");

    const refused = errorOf(await a.workspaceService.rename(rootId, "renamed"));
    expect(refused).toContain(inUseElsewhere);
    expect(refused).toContain("turn");
    expect(renameWorkspace).not.toHaveBeenCalled();

    await releaseAll();
    await a.workspaceService.rename(rootId, "renamed");
    expect(renameWorkspace).toHaveBeenCalledTimes(1);
  });

  test("rename of a workspace refuses while the other backend uses a sub-agent sharing its checkout", async () => {
    await a.config.editConfig((config) => {
      config.projects.get(projectPath)!.workspaces.push({
        ...projectWorkspace(projectPath, "root", sharedChildId, { name: "shared" }),
        parentWorkspaceId: rootId,
        taskIsolation: "none",
        runtimeConfig: { type: "worktree", srcBaseDir },
      });
      return config;
    });
    await hold(b, sharedChildId, "terminal");

    const refused = errorOf(await a.workspaceService.rename(rootId, "renamed"));
    expect(refused).toContain(inUseElsewhere);
    expect(refused).toContain(sharedChildId);
    expect(renameWorkspace).not.toHaveBeenCalled();
  });

  test("a checkout-deleting archive refuses this backend's own terminal in a sub-agent sharing the checkout", async () => {
    await a.config.editConfig((config) => {
      config.projects.get(projectPath)!.workspaces.push({
        ...projectWorkspace(projectPath, "root", sharedChildId, { name: "shared" }),
        parentWorkspaceId: rootId,
        taskIsolation: "none",
        taskStatus: "reported",
        runtimeConfig: { type: "worktree", srcBaseDir },
      });
      return config;
    });
    // Archive ends only the archived workspace's own terminals, not the sub-agent's.
    await hold(a, sharedChildId, "terminal");

    const refused = errorOf(
      await a.workspaceService.archive(rootId, undefined, {
        worktreeArchiveBehaviorOverride: "delete",
      })
    );
    expect(refused).toContain("running terminal in this Xum process");
    expect(refused).toContain(sharedChildId);
    expect(rowOf(a.config, rootId)?.archivedAt).toBeUndefined();
  });

  test("rename refuses this backend's own turn (#4478) but not its own terminal", async () => {
    await hold(a, rootId, "turn");
    expect(errorOf(await a.workspaceService.rename(rootId, "renamed"))).toContain(
      "running turn in this Xum process"
    );
    expect(renameWorkspace).not.toHaveBeenCalled();

    await releaseAll();
    await hold(a, rootId, "terminal");
    await a.workspaceService.rename(rootId, "renamed");
    expect(renameWorkspace).toHaveBeenCalledTimes(1);
  });

  test("remove refuses before any effect while the other backend has a terminal open", async () => {
    await hold(b, rootId, "terminal");

    expect(errorOf(await a.workspaceService.remove(rootId, true))).toContain(inUseElsewhere);
    expect(deleteWorkspace).not.toHaveBeenCalled();
    const row = rowOf(a.config, rootId);
    expect(row).toBeDefined();
    expect(row?.pendingRemoval).toBeUndefined();

    await releaseAll();
    expect(await a.workspaceService.remove(rootId, true)).toMatchObject({ success: true });
    expect(deleteWorkspace).toHaveBeenCalledTimes(1);
    expect(rowOf(a.config, rootId)).toBeUndefined();
  });

  test("remove still ends this backend's own turn and terminals itself", async () => {
    await hold(a, rootId, "turn");
    await hold(a, rootId, "terminal");

    expect(await a.workspaceService.remove(rootId, true)).toMatchObject({ success: true });
    expect(deleteWorkspace).toHaveBeenCalledTimes(1);
  });

  test("an archive that deletes the checkout refuses while the other backend uses it; keep-mode archive does not", async () => {
    await hold(b, rootId, "turn");

    const refused = errorOf(
      await a.workspaceService.archive(rootId, undefined, {
        worktreeArchiveBehaviorOverride: "delete",
      })
    );
    expect(refused).toContain(inUseElsewhere);
    expect(rowOf(a.config, rootId)?.archivedAt).toBeUndefined();

    const kept = await a.workspaceService.archive(rootId, undefined, {
      worktreeArchiveBehaviorOverride: "keep",
    });
    expect(kept).toMatchObject({ success: true, data: { kind: "archived" } });
    expect(rowOf(a.config, rootId)?.archivedAt).toBeDefined();
  });

  test("worktree deletion and snapshot restore of an archived workspace refuse while the other backend uses it", async () => {
    const removeWorktree = spyOn(
      removeManagedWorktree,
      "removeManagedGitWorktree"
    ).mockResolvedValue(undefined);
    await editRow(rootId, (row) => {
      row.archivedAt = new Date().toISOString();
      row.worktreeArchiveSnapshot = {
        version: 1,
        capturedAt: new Date().toISOString(),
        stateDirPath: "archive-snapshot",
        projects: [
          {
            projectPath,
            projectName: "repo",
            storageKey: "repo",
            branchName: "root",
            trunkBranch: "main",
            baseSha: "0".repeat(40),
            headSha: "0".repeat(40),
          },
        ],
      };
    });
    await hold(b, rootId, "terminal");

    expect(errorOf(await a.workspaceService.deleteWorktree(rootId))).toContain(inUseElsewhere);
    expect(removeWorktree).not.toHaveBeenCalled();
    expect(errorOf(await a.workspaceService.unarchive(rootId))).toContain(inUseElsewhere);
    expect(rowOf(a.config, rootId)?.unarchivedAt).toBeUndefined();

    await releaseAll();
    // Neither operation stops this backend's own background processes, so those refuse too.
    const ownBackground = spyOn(
      a.workspaceService,
      "hasRunningBackgroundBashProcesses"
    ).mockResolvedValue(true);
    expect(errorOf(await a.workspaceService.deleteWorktree(rootId))).toContain(
      "running background process"
    );
    expect(errorOf(await a.workspaceService.unarchive(rootId))).toContain(
      "running background process"
    );
    expect(removeWorktree).not.toHaveBeenCalled();

    ownBackground.mockRestore();
    expect(await a.workspaceService.deleteWorktree(rootId)).toMatchObject({ success: true });
    expect(removeWorktree).toHaveBeenCalledTimes(1);
  });

  test("a lease of a killed backend process never locks the workspace", async () => {
    // A real second process holds a terminal lease, as a `xum server` would.
    const child = spawn(
      process.execPath,
      [
        "-e",
        `import { WorkspaceUseLeases } from ${JSON.stringify(
          path.join(import.meta.dir, "workspaceUseLeases")
        )};
        await new WorkspaceUseLeases(${JSON.stringify(a.config.rootDir)}).hold(${JSON.stringify(
          rootId
        )}, "terminal");
        console.log("held");
        setInterval(() => undefined, 60_000);`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] }
    );
    const exited = new Promise((resolve) => child.on("exit", resolve));
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("exit", (code) =>
          reject(new Error(`lease holder exited early (${String(code)})`))
        );
        readline.createInterface({ input: child.stdout }).once("line", () => resolve());
      });

      const refused = errorOf(await a.workspaceService.remove(rootId, true));
      expect(refused).toContain(inUseElsewhere);
      expect(refused).toContain(`pid ${String(child.pid)}`);
      expect(deleteWorkspace).not.toHaveBeenCalled();
    } finally {
      child.kill("SIGKILL");
      await exited;
    }

    expect(await a.workspaceService.remove(rootId, true)).toMatchObject({ success: true });
    expect(deleteWorkspace).toHaveBeenCalledTimes(1);
  });

  // #4857: one-off commands (executeBash) and init hooks run in the checkout too.
  const heldCount = (backend: Backend, kind: WorkspaceUseKind) =>
    workspaceUseLeasesFor(backend.config).heldCount(rootId, kind);

  test("a one-off command of the other backend refuses rename until it fails", async () => {
    const runtimeReady = Promise.withResolvers<{ ready: false; error: string }>();
    ensureReady.mockImplementation(() => runtimeReady.promise);
    const exec = b.workspaceService.executeBash(rootId, "git status");
    while (ensureReady.mock.calls.length === 0) await new Promise((r) => setTimeout(r, 1));

    const refused = errorOf(await a.workspaceService.rename(rootId, "renamed"));
    expect(refused).toContain(inUseElsewhere);
    expect(refused).toContain("exec");
    expect(renameWorkspace).not.toHaveBeenCalled();

    runtimeReady.resolve({ ready: false, error: "runtime down" });
    expect(errorOf(await exec)).toContain("runtime down");
    expect(heldCount(b, "exec")).toBe(0);
    await a.workspaceService.rename(rootId, "renamed");
    expect(renameWorkspace).toHaveBeenCalledTimes(1);
  });

  test("a one-off command releases its lease when it succeeds", async () => {
    ensureReady.mockResolvedValue({ ready: true });
    const execute = mock(() => {
      expect(heldCount(b, "exec")).toBe(1);
      return Promise.resolve({ success: true, output: "clean", exitCode: 0, wall_duration_ms: 1 });
    });
    spyOn(bashToolModule, "createBashTool").mockReturnValue({
      execute,
    } as unknown as ReturnType<typeof bashToolModule.createBashTool>);

    expect(await b.workspaceService.executeBash(rootId, "git status")).toMatchObject({
      success: true,
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(heldCount(b, "exec")).toBe(0);
  });

  test("no one-off command runs while the other backend mutates the workspace", async () => {
    const release = await workspaceUseLeasesFor(a.config).acquireMutationGate([rootId], {
      hasRunningBackgroundProcesses: () => Promise.resolve(false),
    });
    try {
      expect(errorOf(await b.workspaceService.executeBash(rootId, "git status"))).toContain(
        "being renamed, removed or archived"
      );
      expect(ensureReady).not.toHaveBeenCalled();
      expect(heldCount(b, "exec")).toBe(0);
    } finally {
      await release();
    }
  });

  function initRun(
    backend: Backend,
    initWorkspace: (params: WorkspaceInitParams) => Promise<{ success: boolean }>,
    abortSignal?: AbortSignal
  ) {
    const initLogger = {
      logStep: mock(() => undefined),
      logStdout: mock(() => undefined),
      logStderr: mock(() => undefined),
      logComplete: mock(() => undefined),
    };
    const initWorkspaceMock = mock(initWorkspace);
    const settled = runtimeFactory.runBackgroundInit(
      { initWorkspace: initWorkspaceMock } as unknown as Runtime,
      {
        projectPath,
        branchName: "root",
        trunkBranch: "main",
        workspacePath: path.join(srcBaseDir, "repo", "root"),
        initLogger,
        abortSignal,
      },
      rootId,
      workspaceUseLeasesFor(backend.config)
    );
    return { settled, initLogger, initWorkspace: initWorkspaceMock };
  }

  test("an init hook of the other backend refuses rename until it ends", async () => {
    const hook = Promise.withResolvers<{ success: boolean }>();
    const run = initRun(b, () => hook.promise);
    while (run.initWorkspace.mock.calls.length === 0) await new Promise((r) => setTimeout(r, 1));

    const refused = errorOf(await a.workspaceService.rename(rootId, "renamed"));
    expect(refused).toContain(inUseElsewhere);
    expect(refused).toContain("init");

    hook.resolve({ success: true });
    await run.settled;
    expect(heldCount(b, "init")).toBe(0);
    await a.workspaceService.rename(rootId, "renamed");
    expect(renameWorkspace).toHaveBeenCalledTimes(1);
  });

  test("an init hook releases its lease when it fails or is aborted", async () => {
    const failed = initRun(b, () => Promise.reject(new Error("hook crashed")));
    await failed.settled;
    expect(failed.initLogger.logComplete).toHaveBeenCalledWith(-1);
    expect(heldCount(b, "init")).toBe(0);

    const abort = new AbortController();
    const aborted = initRun(
      b,
      (params) =>
        new Promise((resolve) =>
          params.abortSignal?.addEventListener("abort", () => resolve({ success: false }))
        ),
      abort.signal
    );
    while (aborted.initWorkspace.mock.calls.length === 0) {
      await new Promise((r) => setTimeout(r, 1));
    }
    expect(heldCount(b, "init")).toBe(1);
    abort.abort();
    await aborted.settled;
    expect(heldCount(b, "init")).toBe(0);
  });

  test("no init hook runs while the other backend mutates the workspace", async () => {
    const release = await workspaceUseLeasesFor(a.config).acquireMutationGate([rootId], {
      hasRunningBackgroundProcesses: () => Promise.resolve(false),
    });
    try {
      const run = initRun(b, () => Promise.resolve({ success: true }));
      await run.settled;
      expect(run.initWorkspace).not.toHaveBeenCalled();
      expect(run.initLogger.logComplete).toHaveBeenCalledWith(-1);
      expect(heldCount(b, "init")).toBe(0);
    } finally {
      await release();
    }
  });

  // #4883: an external editor's lifetime cannot be tracked, so its open holds an "editor" lease
  // until this backend archives or removes the workspace.
  test("an editor opened by the other backend refuses rename until that backend archives the workspace", async () => {
    expect(await b.workspaceService.recordExternalEditorOpenForLaunch(rootId)).toMatchObject({
      success: true,
    });
    const refused = errorOf(await a.workspaceService.rename(rootId, "renamed"));
    expect(refused).toContain(inUseElsewhere);
    expect(refused).toContain("editor");
    expect(renameWorkspace).not.toHaveBeenCalled();

    // This backend's own rename treats its editor like its terminals, as before.
    expect(await a.workspaceService.recordExternalEditorOpenForLaunch(rootId)).toMatchObject({
      success: true,
    });
    await b.workspaceService.archive(rootId, undefined, {
      worktreeArchiveBehaviorOverride: "keep",
    });
    expect(heldCount(b, "editor")).toBe(0);
    await a.workspaceService.unarchive(rootId);
    await a.workspaceService.rename(rootId, "renamed");
    expect(renameWorkspace).toHaveBeenCalledTimes(1);
  });

  test("no editor open is recorded while the other backend mutates the workspace", async () => {
    const release = await workspaceUseLeasesFor(a.config).acquireMutationGate([rootId], {
      hasRunningBackgroundProcesses: () => Promise.resolve(false),
    });
    try {
      expect(errorOf(await b.workspaceService.recordExternalEditorOpenForLaunch(rootId))).toContain(
        "being renamed, removed or archived"
      );
      expect(await b.workspaceService.hasUntrackableExternalAppOpen(rootId)).toBe(false);
      expect(heldCount(b, "editor")).toBe(0);
    } finally {
      await release();
    }
  });

  test("own MCP servers, init hook and one-off commands follow what each mutator ends", async () => {
    // Rename moves the checkout under its own MCP servers (their processes follow it) and
    // in-flight commands, as before, but nothing stops its own init hook.
    await hold(a, rootId, "init");
    expect(errorOf(await a.workspaceService.rename(rootId, "renamed"))).toContain(
      "running init in this Xum process"
    );
    await releaseAll();
    await hold(a, rootId, "mcp");
    await hold(a, rootId, "exec");
    await a.workspaceService.rename(rootId, "renamed");
    expect(renameWorkspace).toHaveBeenCalledTimes(1);

    // Removal stops its own MCP servers and init hook itself.
    await hold(a, rootId, "init");
    expect(await a.workspaceService.remove(rootId, true)).toMatchObject({ success: true });
    expect(deleteWorkspace).toHaveBeenCalledTimes(1);
  });
});
