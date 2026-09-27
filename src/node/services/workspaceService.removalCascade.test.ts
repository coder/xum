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

  test("an idle tree is removed completely, on disk and in config", async () => {
    const result = await removeRootWithTree();

    expect(result).toEqual({ success: true, data: undefined });
    for (const id of allIds) {
      expect(findWorkspaceInConfig(b.config, id)).toBeUndefined();
      expect(await exists(checkouts.get(id)!)).toBe(false);
    }
  });
});
