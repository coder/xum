import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "fs";
import path from "path";
import { createMuxMessage } from "@/common/types/message";
import type { Config } from "@/node/config";
import * as runtimeFactory from "@/node/runtime/runtimeFactory";
import { createTestProject, saveWorkspaces } from "./taskService.testHarness";
import type { WorkspaceServiceHarness } from "./workspaceService.testHarness";
import { createWorkspaceServiceHarness } from "./workspaceService.testHarness";

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
});
