import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
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
