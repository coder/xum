import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as fsPromises from "node:fs/promises";
import * as path from "path";

import type { Config, Workspace as WorkspaceConfigEntry } from "@/node/config";
import { Err, Ok } from "@/common/types/result";
import { HistoryService } from "@/node/services/historyService";
import type { TaskService } from "@/node/services/taskService";
import {
  createTaskServiceStack,
  createTestConfig,
  createTestProject,
  findWorkspaceInConfig,
  saveWorkspaces,
  testTaskSettings,
  workspaceTurnManagerFor,
  workspaceTurnManagerInternals,
  workspaceTurnRecord,
} from "@/node/services/taskService.testHarness";
import type { WorkspaceHost } from "@/node/services/taskWorkspaceSeam";
import { createTestHistoryService } from "@/node/services/testHistoryService";
import type { WorkspaceService } from "@/node/services/workspaceService";
import {
  createMockAIService,
  createWorkspaceServiceForTest,
} from "@/node/services/workspaceService.testHarness";
import { workspaceUseLeasesFor, type WorkspaceUseLease } from "@/node/services/workspaceUseLeases";
import { WorkspaceLifecycleHooks } from "@/node/services/workspaceLifecycleHooks";
import { createWorktreeArchiveHook } from "@/node/runtime/worktreeLifecycleHooks";
import type { WorktreeArchiveBehavior } from "@/common/config/worktreeArchiveBehavior";
import { WorktreeArchiveSnapshotService } from "@/node/services/worktreeArchiveSnapshotService";

// #4477: archiving a parent archives its sub-agent tree with the parent's worktree archive
// behavior. A keep-mode archive must never delete a checkout, and a busy descendant (in either
// backend) refuses the whole archive.

const rootId = "root-archive";
const childId = "child-archive";
const grandchildId = "grandchild-archive";

const exists = (p: string) =>
  fsPromises.access(p).then(
    () => true,
    () => false
  );

interface Backend {
  config: Config;
  workspaceService: WorkspaceService;
  taskService: TaskService;
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
  const { taskService } = createTaskServiceStack(config, {
    historyService,
    workspaceService: workspaceService as unknown as WorkspaceHost,
  });
  // The production after-archive hook: it deletes a managed checkout when the behavior says so.
  const hooks = new WorkspaceLifecycleHooks();
  hooks.registerAfterArchive(
    createWorktreeArchiveHook({ getWorktreeArchiveBehavior: () => "keep" })
  );
  workspaceService.setWorkspaceLifecycleHooks(hooks);
  workspaceService.setAgentTaskIntegration(
    taskService as unknown as Parameters<WorkspaceService["setAgentTaskIntegration"]>[0]
  );
  return { config, workspaceService, taskService };
}

describe("parent archive cascades over its sub-agent tree across two backends", () => {
  let cleanupFixture: () => Promise<void>;
  let a: Backend;
  let b: Backend;
  const checkouts = new Map<string, string>();
  const leases: WorkspaceUseLease[] = [];

  beforeEach(async () => {
    const fixture = await createTestHistoryService();
    cleanupFixture = fixture.cleanup;
    const projectPath = await createTestProject(fixture.tempDir, "repo");
    const srcBaseDir = path.join(fixture.tempDir, "src");
    // Real git worktrees: the assertions read the disk, not a runtime stub.
    const row = (id: string, extra: Partial<WorkspaceConfigEntry> = {}): WorkspaceConfigEntry => {
      const checkout = path.join(srcBaseDir, "repo", id);
      execFileSync("git", ["worktree", "add", "-q", "-b", id, checkout], { cwd: projectPath });
      checkouts.set(id, checkout);
      return {
        id,
        name: id,
        path: checkout,
        runtimeConfig: { type: "worktree", srcBaseDir },
        ...extra,
      };
    };
    const task = (parentWorkspaceId: string): Partial<WorkspaceConfigEntry> => ({
      parentWorkspaceId,
      agentType: "explore",
      agentId: "explore",
      taskStatus: "reported",
      taskModelString: "openai:gpt-5.2",
    });
    await saveWorkspaces(
      fixture.config,
      projectPath,
      [row(rootId), row(childId, task(rootId)), row(grandchildId, task(childId))],
      testTaskSettings()
    );
    a = createBackend(fixture.config, fixture.historyService);
    const configB = await createTestConfig(fixture.tempDir);
    b = createBackend(configB, new HistoryService(configB));
  });

  afterEach(async () => {
    for (const lease of leases.splice(0)) await lease.release();
    checkouts.clear();
    mock.restore();
    await cleanupFixture();
  });

  const allIds = [rootId, childId, grandchildId];

  async function setArchiveBehavior(behavior: WorktreeArchiveBehavior): Promise<void> {
    await a.config.editConfig((config) => ({ ...config, worktreeArchiveBehavior: behavior }));
  }

  test("a keep-mode archive archives the whole tree and never deletes a checkout", async () => {
    await setArchiveBehavior("keep");

    const result = await a.workspaceService.archive(rootId);

    expect(result).toEqual({ success: true, data: { kind: "archived" } });
    for (const id of allIds) {
      expect(findWorkspaceInConfig(b.config, id)?.archivedAt).toBeDefined();
      expect(await exists(checkouts.get(id)!)).toBe(true);
    }
  });

  test("a delete-mode archive refuses while the other backend uses a descendant, archiving nothing", async () => {
    await setArchiveBehavior("delete");
    leases.push(await workspaceUseLeasesFor(b.config).hold(childId, "terminal"));

    const result = await a.workspaceService.archive(rootId);

    expect(result.success).toBe(false);
    expect(result.success ? "" : result.error).toContain(childId);
    expect(result.success ? "" : result.error).toContain("in use by another Xum process");
    for (const id of allIds) {
      expect(findWorkspaceInConfig(a.config, id)?.archivedAt).toBeUndefined();
      expect(await exists(checkouts.get(id)!)).toBe(true);
    }
  });

  test("a parentWorkspaceId cycle gets the single-workspace archive's answer instead of a thrown error", async () => {
    await setArchiveBehavior("keep");
    await a.config.editConfig((config) => {
      const row = [...config.projects.values()][0].workspaces.find((w) => w.id === rootId)!;
      row.parentWorkspaceId = grandchildId;
      return config;
    });

    // Listing the tree throws on the cycle; the archive falls back to the workspace alone,
    // whose own descendant check refuses this malformed tree with a normal Result.
    const result = await a.workspaceService.archive(rootId);

    expect(result.success).toBe(false);
    expect(result.success ? "" : result.error).toContain("active descendant sub-agents");
    for (const id of allIds) {
      expect(findWorkspaceInConfig(a.config, id)?.archivedAt).toBeUndefined();
    }
  });

  // #4930: the model-facing archive (task_workspace_lifecycle) cascades like the user's archive,
  // keeping its lossy-removal contract: it refuses with the at-risk paths, never with an ack.
  const ownerId = "owner-archive";

  async function modelArchiveRoot() {
    await workspaceTurnManagerInternals(a.taskService).taskHandleStore.upsertWorkspaceTurn(
      workspaceTurnRecord(ownerId, rootId, "wst_root", "completed", { createdWorkspace: true })
    );
    return await workspaceTurnManagerFor(a.taskService).archiveOwnedWorkspaceTurnWorkspace(
      ownerId,
      { workspaceId: rootId }
    );
  }

  test("a model-facing archive archives the parent's inactive sub-agents with it", async () => {
    await setArchiveBehavior("keep");

    const result = await modelArchiveRoot();

    expect(result.success && result.data.status).toBe("archived");
    for (const id of allIds) {
      expect(findWorkspaceInConfig(b.config, id)?.archivedAt).toBeDefined();
      expect(await exists(checkouts.get(id)!)).toBe(true);
    }
  });

  test("a model-facing archive refuses while a sub-agent is active, archiving nothing", async () => {
    await setArchiveBehavior("keep");
    await a.config.editConfig((config) => {
      const row = [...config.projects.values()][0].workspaces.find((w) => w.id === grandchildId)!;
      row.taskStatus = "running";
      return config;
    });

    const result = await modelArchiveRoot();

    expect(result.success && result.data.status).toBe("error");
    expect(result.success ? result.data.error : "").toContain("active descendant sub-agents");
    for (const id of allIds) {
      expect(findWorkspaceInConfig(a.config, id)?.archivedAt).toBeUndefined();
    }
  });

  test("a model-facing snapshot archive refuses with a sub-agent's untracked paths, archiving nothing", async () => {
    await setArchiveBehavior("snapshot");
    a.workspaceService.setWorktreeArchiveSnapshotService(
      new WorktreeArchiveSnapshotService(a.config)
    );
    await fsPromises.writeFile(path.join(checkouts.get(grandchildId)!, "notes.txt"), "unsaved\n");

    const result = await modelArchiveRoot();

    assert(result.success, "the lifecycle archive returns a result");
    expect(result.data.status).toBe("error");
    expect(result.data.paths).toEqual([`${grandchildId}: notes.txt`]);
    expect(result.data.error).toContain(grandchildId);
    for (const id of allIds) {
      expect(findWorkspaceInConfig(a.config, id)?.archivedAt).toBeUndefined();
      expect(await exists(checkouts.get(id)!)).toBe(true);
    }
    expect(await exists(path.join(checkouts.get(grandchildId)!, "notes.txt"))).toBe(true);
  });

  test("a model-facing snapshot archive refuses with the parent's own untracked paths before archiving its sub-agents", async () => {
    await setArchiveBehavior("snapshot");
    a.workspaceService.setWorktreeArchiveSnapshotService(
      new WorktreeArchiveSnapshotService(a.config)
    );
    await fsPromises.writeFile(path.join(checkouts.get(rootId)!, "notes.txt"), "unsaved\n");

    const result = await modelArchiveRoot();

    assert(result.success, "the lifecycle archive returns a result");
    expect(result.data.status).toBe("error");
    expect(result.data.paths).toEqual(["notes.txt"]);
    for (const id of allIds) {
      expect(findWorkspaceInConfig(a.config, id)?.archivedAt).toBeUndefined();
    }
  });

  test("a delete-mode archive of an idle tree archives every row and deletes every checkout", async () => {
    await setArchiveBehavior("delete");

    const result = await a.workspaceService.archive(rootId);

    expect(result).toEqual({ success: true, data: { kind: "archived" } });
    for (const id of allIds) {
      expect(findWorkspaceInConfig(b.config, id)?.archivedAt).toBeDefined();
      expect(await exists(checkouts.get(id)!)).toBe(false);
    }
  });
});
