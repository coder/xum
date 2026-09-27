import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
import * as path from "path";
import * as readline from "node:readline";

import type { Config, Workspace as WorkspaceConfigEntry } from "@/node/config";
import { Err, Ok } from "@/common/types/result";
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
    spyOn(runtimeFactory, "createRuntime").mockReturnValue({
      renameWorkspace,
      deleteWorkspace,
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
});
