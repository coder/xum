import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync } from "fs";
import * as fsPromises from "fs/promises";
import path from "path";
import { createMuxMessage } from "@/common/types/message";
import { Err } from "@/common/types/result";
import { getPlanFilePath } from "@/common/utils/planStorage";
import type { Config } from "@/node/config";
import * as runtimeFactory from "@/node/runtime/runtimeFactory";
import { createTestProject, saveWorkspaces } from "./taskService.testHarness";
import type { WorkspaceServiceHarness } from "./workspaceService.testHarness";
import {
  createWorkspaceServiceHarness,
  withTempMuxRoot,
  writePlanFile,
} from "./workspaceService.testHarness";

// `/side` chats: ephemeral forks that share the parent's real worktree checkout. The parent is a
// real git worktree so removal paths exercise actual checkout deletion (or its absence).
describe("WorkspaceService.createSideChat", () => {
  const parentId = "parent-side-chat";
  let harness: WorkspaceServiceHarness;
  let config: Config;
  let projectPath: string;
  let parentPath: string;

  beforeEach(async () => {
    harness = await createWorkspaceServiceHarness();
    config = harness.config;
    projectPath = await createTestProject(config.rootDir);
    const runtimeConfig = { type: "worktree" as const, srcBaseDir: config.srcDir };
    const runtime = runtimeFactory.createRuntime(runtimeConfig, { projectPath });
    const created = await runtime.createWorkspace({
      projectPath,
      branchName: "parent",
      trunkBranch: "main",
      directoryName: "parent",
      initLogger: {
        logStep: () => undefined,
        logStdout: () => undefined,
        logStderr: () => undefined,
        logComplete: () => undefined,
        enterHookPhase: () => undefined,
      },
    });
    expect(created.success).toBe(true);
    parentPath = runtime.getWorkspacePath(projectPath, "parent");
    await saveWorkspaces(config, projectPath, [
      { id: parentId, name: "parent", path: parentPath, runtimeConfig },
    ]);
    for (const message of [
      createMuxMessage("parent-u1", "user", "what does this repo do?"),
      createMuxMessage("parent-a1", "assistant", "it is a test repo"),
    ]) {
      expect((await harness.historyService.appendToHistory(parentId, message)).success).toBe(true);
    }
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  async function createSideChatOk(workspaceId: string): Promise<string> {
    const result = await harness.service.createSideChat(workspaceId);
    if (!result.success) throw new Error(`createSideChat failed: ${result.error}`);
    return result.data.metadata.id;
  }

  async function historyIds(workspaceId: string): Promise<string[]> {
    const history = await harness.historyService.getHistoryFromLatestBoundary(workspaceId);
    if (!history.success) throw new Error(`history read failed: ${history.error}`);
    return history.data.map((message) => message.id);
  }

  function sideChatIdsOf(workspaceId: string): string[] {
    return [...config.loadConfigOrDefault().projects.values()]
      .flatMap((project) => project.workspaces)
      .flatMap((ws) =>
        ws.sideChatParentWorkspaceId === workspaceId && ws.id != null ? [ws.id] : []
      );
  }

  test("copies the parent's history and registers a row sharing the parent's checkout", async () => {
    const sideChatId = await createSideChatOk(parentId);

    expect(sideChatId).not.toBe(parentId);
    expect(await historyIds(sideChatId)).toEqual(["parent-u1", "parent-a1"]);
    const row = config.findWorkspace(sideChatId);
    expect(row?.workspacePath).toBe(parentPath);
    const metadata = await config.getWorkspaceMetadataById(sideChatId);
    expect(metadata?.sideChatParentWorkspaceId).toBe(parentId);
    expect(metadata?.taskIsolation).toBe("none");
    expect(sideChatIdsOf(parentId)).toEqual([sideChatId]);
  });

  test("a second side chat of the same parent replaces the first", async () => {
    const first = await createSideChatOk(parentId);
    const second = await createSideChatOk(parentId);

    expect(second).not.toBe(first);
    expect(config.findWorkspace(first)).toBeNull();
    expect(existsSync(path.join(config.sessionsDir, first))).toBe(false);
    expect(sideChatIdsOf(parentId)).toEqual([second]);
    // Discarding the first side chat must not touch the shared checkout.
    expect(existsSync(path.join(parentPath, "README.md"))).toBe(true);
  });

  test("refuses to start a side chat from a side chat", async () => {
    const sideChatId = await createSideChatOk(parentId);

    const nested = await harness.service.createSideChat(sideChatId);

    expect(nested.success).toBe(false);
    // The refused attempt neither registered a nested row nor discarded the existing side chat.
    expect(sideChatIdsOf(sideChatId)).toEqual([]);
    expect(sideChatIdsOf(parentId)).toEqual([sideChatId]);
  });

  test("removing the side chat keeps the parent's checkout, row and history", async () => {
    const sideChatId = await createSideChatOk(parentId);

    const removed = await harness.service.remove(sideChatId, true);

    expect(removed.success).toBe(true);
    expect(config.findWorkspace(sideChatId)).toBeNull();
    expect(existsSync(path.join(config.sessionsDir, sideChatId))).toBe(false);
    expect(existsSync(path.join(parentPath, "README.md"))).toBe(true);
    expect(config.findWorkspace(parentId)?.workspacePath).toBe(parentPath);
    expect(await historyIds(parentId)).toEqual(["parent-u1", "parent-a1"]);
  });

  test("removing the parent also removes its side chat", async () => {
    const sideChatId = await createSideChatOk(parentId);

    const removed = await harness.service.remove(parentId, true);

    expect(removed.success).toBe(true);
    expect(config.findWorkspace(parentId)).toBeNull();
    expect(config.findWorkspace(sideChatId)).toBeNull();
    expect(existsSync(path.join(config.sessionsDir, sideChatId))).toBe(false);
  });

  // The side chat goes only with a removal that went through: a no-op or refused removal leaves
  // the parent registered, and with it the user's side chat.
  test("a parent removal that turns into a no-op keeps the side chat", async () => {
    const sideChatId = await createSideChatOk(parentId);

    const removed = await harness.service.remove(parentId, true, {
      beforeRemove: () => Promise.resolve(false),
    });

    expect(removed.success).toBe(true);
    expect(config.findWorkspace(parentId)).not.toBeNull();
    expect(sideChatIdsOf(parentId)).toEqual([sideChatId]);
    expect(existsSync(path.join(config.sessionsDir, sideChatId))).toBe(true);
  });

  test("archiving the parent removes its side chat and keeps the checkout", async () => {
    await config.editConfig((cfg) => ({ ...cfg, worktreeArchiveBehavior: "keep" }));
    const sideChatId = await createSideChatOk(parentId);

    const archived = await harness.service.archive(parentId);

    expect(archived).toEqual({ success: true, data: { kind: "archived" } });
    expect(config.findWorkspace(sideChatId)).toBeNull();
    expect(existsSync(path.join(config.sessionsDir, sideChatId))).toBe(false);
    expect(existsSync(path.join(parentPath, "README.md"))).toBe(true);
    // An archived parent cannot start a new one either.
    expect((await harness.service.createSideChat(parentId)).success).toBe(false);
    expect(sideChatIdsOf(parentId)).toEqual([]);
  });

  // Plans are keyed by workspace name, which the side chat does not share with its parent.
  test("the side chat gets a copy of the parent's plan that goes away with it", async () => {
    await withTempMuxRoot(async (root) => {
      const parentMetadata = await config.getWorkspaceMetadataById(parentId);
      if (parentMetadata == null) throw new Error("parent metadata missing");
      const parentPlan = await writePlanFile(root, parentMetadata.projectName, "parent");
      await fsPromises.writeFile(parentPlan, "# Parent plan\n- step one\n");

      const created = await harness.service.createSideChat(parentId);
      if (!created.success) throw new Error(`createSideChat failed: ${created.error}`);
      const sidePlan = getPlanFilePath(
        created.data.metadata.name,
        parentMetadata.projectName,
        root
      );

      expect(sidePlan).not.toBe(parentPlan);
      expect(await fsPromises.readFile(sidePlan, "utf-8")).toBe("# Parent plan\n- step one\n");

      expect((await harness.service.remove(created.data.metadata.id, true)).success).toBe(true);
      expect(existsSync(sidePlan)).toBe(false);
      expect(await fsPromises.readFile(parentPlan, "utf-8")).toBe("# Parent plan\n- step one\n");
    });
  });

  // One side chat per workspace: a previous one that cannot be discarded blocks the new one
  // instead of leaving two.
  test("refuses a replacement while the previous side chat cannot be removed", async () => {
    const first = await createSideChatOk(parentId);
    const service = harness.service;
    const realRemove = service.remove.bind(service);
    const removeSpy = spyOn(service, "remove").mockImplementation((workspaceId, ...rest) =>
      workspaceId === first ? Promise.resolve(Err("in use")) : realRemove(workspaceId, ...rest)
    );
    try {
      const second = await service.createSideChat(parentId);

      expect(second.success).toBe(false);
      expect(removeSpy).toHaveBeenCalledWith(first, true);
      expect(sideChatIdsOf(parentId)).toEqual([first]);
    } finally {
      removeSpy.mockRestore();
    }
  });
});
