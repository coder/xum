import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { localBgWorkspaceDir } from "./backgroundProcessExecutor";
import { execFileSync } from "node:child_process";
import * as fsPromises from "node:fs/promises";
import * as path from "path";

import type { Config, Workspace as WorkspaceConfigEntry } from "@/node/config";
import { Err, Ok } from "@/common/types/result";
import { HistoryService } from "@/node/services/historyService";
import { WorktreeRuntime } from "@/node/runtime/WorktreeRuntime";
import type { TaskService } from "@/node/services/taskService";
import {
  createTaskServiceStack,
  createTestConfig,
  createTestProject,
  findWorkspaceInConfig,
  saveWorkspaces,
  testTaskSettings,
} from "@/node/services/taskService.testHarness";
import type { WorkspaceHost } from "@/node/services/taskWorkspaceSeam";
import { createTestHistoryService } from "@/node/services/testHistoryService";
import type { WorkspaceService } from "@/node/services/workspaceService";
import {
  createMockAIService,
  createWorkspaceServiceForTest,
} from "@/node/services/workspaceService.testHarness";
import { workspaceUseLeasesFor, type WorkspaceUseLease } from "@/node/services/workspaceUseLeases";

// #4477: deleting a parent removes its sub-agent tree. Another backend on the same root (the
// desktop app beside a `xum server`) may be using any workspace of that tree, so the whole tree is
// checked before the first removal: a busy descendant refuses the delete with nothing removed.

const rootId = "root-cascade";
const childId = "child-cascade";
const grandchildId = "grandchild-cascade";

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
  workspaceService.setAgentTaskIntegration(
    taskService as unknown as Parameters<WorkspaceService["setAgentTaskIntegration"]>[0]
  );
  return { config, workspaceService, taskService };
}

describe("parent removal cascades over its sub-agent tree across two backends", () => {
  let cleanupFixture: () => Promise<void>;
  let a: Backend;
  let b: Backend;
  const checkouts = new Map<string, string>();
  const leases: WorkspaceUseLease[] = [];
  const processRecords: string[] = [];

  async function createProcessRecord(workspaceId: string, running = false): Promise<string> {
    const recordPath = path.join(localBgWorkspaceDir(workspaceId), `recovery-${randomUUID()}`);
    processRecords.push(recordPath);
    await fsPromises.mkdir(recordPath, { recursive: true });
    if (running) {
      await fsPromises.writeFile(
        path.join(recordPath, "meta.json"),
        JSON.stringify({ pid: process.pid, status: "running" })
      );
    }
    return recordPath;
  }

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
    for (const recordPath of processRecords.splice(0)) {
      await fsPromises.rm(recordPath, { recursive: true, force: true });
    }
    checkouts.clear();
    mock.restore();
    await cleanupFixture();
  });

  const allIds = [rootId, childId, grandchildId];
  const removeRootWithTree = () =>
    a.workspaceService.remove(rootId, true, { acknowledgedDescendantIds: [grandchildId, childId] });

  test("a descendant in use by the other backend refuses the parent delete before anything is removed", async () => {
    // The middle node is busy: removing deepest-first would already have deleted the grandchild.
    leases.push(await workspaceUseLeasesFor(b.config).hold(childId, "terminal"));

    const result = await removeRootWithTree();

    expect(result.success).toBe(false);
    expect(result.success ? "" : result.error).toContain(childId);
    expect(result.success ? "" : result.error).toContain("in use by another Xum process");
    for (const id of allIds) {
      expect(findWorkspaceInConfig(a.config, id)).toBeDefined();
      expect(await exists(checkouts.get(id)!)).toBe(true);
      expect(findWorkspaceInConfig(a.config, id)?.pendingRemoval).toBeUndefined();
    }
  });

  test("an unknown parent record does not hide a running descendant process", async () => {
    const unknown = await createProcessRecord(rootId);
    const running = await createProcessRecord(childId, true);
    const result = await removeRootWithTree();

    expect(result.success).toBe(false);
    expect(result.backgroundProcesses?.find((record) => record.recordPath === unknown)?.state).toBe(
      "unknown"
    );
    expect(result.backgroundProcesses?.find((record) => record.recordPath === running)?.state).toBe(
      "running"
    );
    for (const id of allIds) {
      expect(await exists(checkouts.get(id)!)).toBe(true);
      expect(findWorkspaceInConfig(a.config, id)?.pendingRemoval).toBeUndefined();
    }
  });

  test("exact unknown-record confirmation removes the complete acknowledged tree", async () => {
    const records = await Promise.all(allIds.map((id) => createProcessRecord(id)));
    const refused = await removeRootWithTree();
    expect(refused.success).toBe(false);
    expect(refused.backgroundProcesses).toHaveLength(allIds.length);
    for (const id of allIds) expect(await exists(checkouts.get(id)!)).toBe(true);

    const result = await a.workspaceService.remove(rootId, true, {
      acknowledgedDescendantIds: [grandchildId, childId],
      acknowledgedUnknownProcessRecords: records,
    });
    expect(result.success).toBe(true);
    for (const id of allIds) {
      expect(findWorkspaceInConfig(b.config, id)).toBeUndefined();
      expect(await exists(checkouts.get(id)!)).toBe(false);
    }
  });

  test("an idle tree is removed completely, on disk and in config", async () => {
    const result = await removeRootWithTree();

    expect(result).toEqual({ success: true, data: undefined });
    for (const id of allIds) {
      expect(findWorkspaceInConfig(b.config, id)).toBeUndefined();
      expect(await exists(checkouts.get(id)!)).toBe(false);
    }
  });

  // #5143: Shift-click forces the parent removal together with its acknowledged sub-agents, so
  // what a descendant's forced removal left behind reaches the user with the parent's result.
  test("a descendant's leftovers are returned with the parent removal", async () => {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- applied with the runtime as this
    const deleteWorkspace = WorktreeRuntime.prototype.deleteWorkspace;
    spyOn(WorktreeRuntime.prototype, "deleteWorkspace").mockImplementation(function (
      this: WorktreeRuntime,
      ...args: Parameters<WorktreeRuntime["deleteWorkspace"]>
    ) {
      if (args[1] !== childId) return deleteWorkspace.apply(this, args);
      return Promise.resolve({
        success: false,
        error: "teardown failed",
        leftoverPaths: ["/leftover/child"],
      });
    });

    const result = await removeRootWithTree();

    expect(result.success).toBe(true);
    expect(result.warnings).toEqual([
      { kind: "leftover", description: "/leftover/child was left behind; remove it manually." },
    ]);
  });

  /** Makes the runtime fail to delete this workspace's checkout and name no leftover. */
  function failDiskDeletionOf(workspaceName: string) {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- applied with the runtime as this
    const deleteWorkspace = WorktreeRuntime.prototype.deleteWorkspace;
    spyOn(WorktreeRuntime.prototype, "deleteWorkspace").mockImplementation(function (
      this: WorktreeRuntime,
      ...args: Parameters<WorktreeRuntime["deleteWorkspace"]>
    ) {
      if (args[1] !== workspaceName) return deleteWorkspace.apply(this, args);
      return Promise.resolve({ success: false, error: "teardown failed" });
    });
  }

  // A forced removal drops the row even when the disk deletion failed. With no named leftover it
  // used to say nothing, so a caller could not tell that the checkout may still exist.
  test("a descendant whose forced disk deletion failed is returned as a warning", async () => {
    failDiskDeletionOf(childId);

    const result = await removeRootWithTree();

    expect(result.success).toBe(true);
    expect(result.warnings).toEqual([
      {
        kind: "leftover",
        description: `${checkouts.get(childId)} could not be deleted (teardown failed) and may still exist; remove it manually.`,
      },
    ]);
    expect(findWorkspaceInConfig(a.config, childId)).toBeUndefined();
  });

  test("a forced task_remove whose disk deletion failed says the work may remain", async () => {
    failDiskDeletionOf(grandchildId);
    const checkout = checkouts.get(grandchildId)!;
    await fsPromises.writeFile(path.join(checkout, "notes.txt"), "unsaved\n");

    const result = await a.taskService.removeInactiveDescendantAgentTask(rootId, grandchildId, {
      lossyWorkPolicy: "force",
    });

    expect(result.success).toBe(true);
    const data = result.success ? result.data : undefined;
    expect(data?.status).toBe("removed");
    expect(data?.paths).toEqual(["notes.txt"]);
    expect(data?.deletedWork).toContain(checkout);
    expect(data?.deletedWork).toContain("may remain");
    expect(findWorkspaceInConfig(a.config, grandchildId)).toBeUndefined();
  });

  // #5028: the mark a task gets when the write ending it rejects (#4747) is in-memory only and
  // has no reader once the row is gone. White-box: the leak is its only observable effect.
  test("removing tasks drops their unpersisted-end marks", async () => {
    const marks = (
      a.taskService as unknown as { waiters: { unpersistedLaunchFailureTaskIds: Set<string> } }
    ).waiters.unpersistedLaunchFailureTaskIds;
    marks.add(childId);
    marks.add(grandchildId);

    const result = await removeRootWithTree();

    expect(result.success).toBe(true);
    expect([...marks]).toEqual([]);
  });

  // #5334: the stop generations that peer-send admission latches (#5311) are in-memory only and
  // have no reader once the workspace is gone. White-box, as above: the leak is their only effect.
  test("removing workspaces drops their stop generations", async () => {
    for (const id of allIds) a.taskService.markParentWorkspaceInterrupted(id);
    const userStopEpochs = (
      a.taskService as unknown as { workspaceUserStopEpochs: Map<string, number> }
    ).workspaceUserStopEpochs;
    const stopEpochs = (
      a.taskService as unknown as { taskStopLatch: { workspaceStopEpochs: Map<string, number> } }
    ).taskStopLatch.workspaceStopEpochs;
    expect([...userStopEpochs.keys()].sort()).toEqual([...allIds].sort());
    expect([...stopEpochs.keys()].sort()).toEqual([...allIds].sort());

    const result = await removeRootWithTree();

    expect(result.success).toBe(true);
    expect([...userStopEpochs.keys()]).toEqual([]);
    expect([...stopEpochs.keys()]).toEqual([]);
  });
});
