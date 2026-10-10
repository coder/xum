import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync } from "fs";
import * as fsPromises from "fs/promises";
import path from "path";
import {
  STAGED_ATTACHMENT_DIR,
  STAGED_ATTACHMENT_MIRROR_DIR_NAME,
} from "@/common/constants/stagedAttachments";
import { createMuxMessage } from "@/common/types/message";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { Err, Ok } from "@/common/types/result";
import * as workspaceTitleGenerator from "./workspaceTitleGenerator";
import { getPlanFilePath } from "@/common/utils/planStorage";
import { Config } from "@/node/config";
import { getSelfIdentity } from "@/node/utils/concurrency/processLiveness";
import * as runtimeFactory from "@/node/runtime/runtimeFactory";
import { createTestProject, saveWorkspaces } from "./taskService.testHarness";
import { makeAgentTaskIntegrationFake } from "./taskWorkspaceSeam.testUtils";
import type { WorkspaceServiceHarness } from "./workspaceService.testHarness";
import {
  createDeferred,
  createWorkspaceServiceHarness,
  createWorkspaceServiceForTest,
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

  test("titles the side conversation from its first message, not the inherited history", async () => {
    const sideChatId = await createSideChatOk(parentId);
    expect((await config.getWorkspaceMetadataById(sideChatId))?.pendingAutoTitle).toBe(true);
    const generatedTitle = "Why the cache misses";
    const generated = createDeferred<void>();
    const listener = (event: { workspaceId: string; metadata: { title?: string } | null }) => {
      if (event.workspaceId === sideChatId && event.metadata?.title === generatedTitle) {
        generated.resolve();
      }
    };
    harness.service.on("metadata", listener);
    const generator = spyOn(workspaceTitleGenerator, "generateWorkspaceIdentity").mockResolvedValue(
      Ok({ name: "cache-misses", title: generatedTitle, modelUsed: "openai:gpt-4o-mini" })
    );
    const send = spyOn(
      harness.service.getOrCreateSession(sideChatId),
      "sendMessage"
    ).mockResolvedValue(Ok(undefined));
    try {
      const message = "Why does the cache miss on every request?";
      const result = await harness.service.sendMessage(sideChatId, message, {
        model: "openai:gpt-4o-mini",
        agentId: "exec",
      });
      expect(result.success).toBe(true);
      await generated.promise;
      expect(generator).toHaveBeenCalledTimes(1);
      expect(generator.mock.calls[0]?.[0]).toBe(message);
      expect(await config.getWorkspaceMetadataById(sideChatId)).toMatchObject({
        title: generatedTitle,
        pendingAutoTitle: undefined,
      });
      expect(await historyIds(parentId)).toEqual(["parent-u1", "parent-a1"]);
    } finally {
      harness.service.off("metadata", listener);
      generator.mockRestore();
      send.mockRestore();
    }
  });

  test("multiple side chats keep independent histories and can be closed individually", async () => {
    const first = await createSideChatOk(parentId);
    const message = createMuxMessage("first-side-question", "user", "What is the cache policy?");
    expect((await harness.historyService.appendToHistory(first, message)).success).toBe(true);
    const second = await createSideChatOk(parentId);

    expect(second).not.toBe(first);
    expect(sideChatIdsOf(parentId)).toEqual([first, second]);
    expect(await historyIds(first)).toEqual(["parent-u1", "parent-a1", message.id]);
    expect(await historyIds(second)).toEqual(["parent-u1", "parent-a1"]);
    expect(existsSync(path.join(config.sessionsDir, first))).toBe(true);

    expect((await harness.service.remove(first, true)).success).toBe(true);
    expect(config.findWorkspace(first)).toBeNull();
    expect(sideChatIdsOf(parentId)).toEqual([second]);
    expect(await historyIds(second)).toEqual(["parent-u1", "parent-a1"]);
    expect(existsSync(path.join(parentPath, "README.md"))).toBe(true);
  });

  test.each([
    "text partial",
    "pending tools",
    "persisted partial",
    "equal part counts",
    "empty placeholder",
    "user only",
    "newer completed row",
  ] as const)("copies %s as inert context without changing the parent", async (scenario) => {
    const history = harness.historyService;
    expect(
      (
        await history.appendToHistory(
          parentId,
          createMuxMessage("working-user", "user", "Continue the main work")
        )
      ).success
    ).toBe(true);
    const assistant = createMuxMessage("working-assistant", "assistant", "older text", {
      historySequence: 3,
      ...(scenario === "persisted partial" || scenario === "equal part counts"
        ? { partial: true, error: "old error", errorType: "network" as const }
        : {}),
    });
    if (
      scenario === "empty placeholder" ||
      scenario === "text partial" ||
      scenario === "pending tools"
    ) {
      assistant.parts = [];
    }
    if (scenario === "newer completed row")
      assistant.parts = [{ type: "text", text: "Completed main work" }];
    if (scenario !== "user only")
      expect((await history.appendToHistory(parentId, assistant)).success).toBe(true);
    if (
      ["text partial", "pending tools", "equal part counts", "newer completed row"].includes(
        scenario
      )
    ) {
      const partial = {
        ...assistant,
        parts: [{ type: "text" as const, text: "latest partial text" }],
      };
      if (scenario === "pending tools") {
        partial.parts = [];
        expect(
          (
            await history.writePartial(parentId, {
              ...assistant,
              parts: [
                {
                  type: "dynamic-tool",
                  toolCallId: "read-done",
                  toolName: "file_read",
                  state: "output-available",
                  input: { path: "README.md" },
                  output: { contents: "completed read" },
                },
                {
                  type: "dynamic-tool",
                  toolCallId: "running-bash",
                  toolName: "bash",
                  state: "input-available",
                  input: { script: "perform work" },
                },
                {
                  type: "dynamic-tool",
                  toolCallId: "waiting-question",
                  toolName: "ask_user_question",
                  state: "input-available",
                  input: { questions: [] },
                },
              ],
            })
          ).success
        ).toBe(true);
      } else {
        expect((await history.writePartial(parentId, partial)).success).toBe(true);
      }
    }
    const sourceHistory = await history.getHistoryFromLatestBoundary(parentId);
    const sourcePartial = await history.readPartial(parentId);
    const stop = spyOn(harness.aiService, "stopStream");
    try {
      const sideId = await createSideChatOk(parentId);
      const copied = await history.getHistoryFromLatestBoundary(sideId);
      if (!copied.success) throw new Error(copied.error);
      expect(copied.data.slice(0, 2).map((row) => row.id)).toEqual(["parent-u1", "parent-a1"]);
      expect(copied.data.some((row) => row.metadata?.partial === true)).toBe(false);
      expect(copied.data.some((row) => row.metadata?.error != null)).toBe(false);
      expect(
        copied.data
          .flatMap((row) => row.parts)
          .some((part) => part.type === "dynamic-tool" && part.state === "input-available")
      ).toBe(false);
      expect(await history.readPartial(sideId)).toBeNull();
      const tail = copied.data.at(-1);
      expect(tail?.role).toBe("assistant");
      expect(tail?.parts.length).toBeGreaterThan(0);
      if (scenario === "text partial" || scenario === "equal part counts") {
        expect(tail?.parts).toContainEqual({ type: "text", text: "latest partial text" });
      }
      if (scenario === "newer completed row") {
        expect(tail?.parts).toEqual(assistant.parts);
      }
      if (scenario === "pending tools") {
        const completedRead = tail?.parts.find(
          (part) => part.type === "dynamic-tool" && part.toolCallId === "read-done"
        );
        expect(completedRead).toMatchObject({
          state: "output-available",
          output: { contents: "completed read" },
        });
      }
      expect(await history.getHistoryFromLatestBoundary(parentId)).toEqual(sourceHistory);
      expect(await history.readPartial(parentId)).toEqual(sourcePartial);
      expect(stop).not.toHaveBeenCalled();
    } finally {
      stop.mockRestore();
    }
  });

  test("copied compaction context keeps its boundary but not its pending continuation", async () => {
    const history = harness.historyService;
    const summary = createMuxMessage("pending-summary", "assistant", "Completed context summary", {
      compacted: "user",
      compactionBoundary: true,
      compactionEpoch: 1,
      muxMetadata: {
        type: "compaction-summary",
        pendingFollowUp: {
          text: "Continue the main work",
          model: "openai:gpt-4o",
          agentId: "exec",
        },
      },
    });
    expect((await history.appendToHistory(parentId, summary)).success).toBe(true);
    const before = await history.getHistoryFromLatestBoundary(parentId);

    const sideId = await createSideChatOk(parentId);
    const copied = await history.getHistoryFromLatestBoundary(sideId);
    if (!copied.success) throw new Error(copied.error);
    expect(copied.data).toHaveLength(1);
    expect(copied.data[0].parts).toEqual(summary.parts);
    expect(copied.data[0].metadata).toMatchObject({
      compacted: "user",
      compactionBoundary: true,
      compactionEpoch: 1,
      muxMetadata: { type: "compaction-summary" },
    });
    const marker = copied.data[0].metadata?.muxMetadata;
    if (marker?.type !== "compaction-summary") throw new Error("summary marker missing");
    expect(marker.pendingFollowUp).toBeUndefined();
    expect(await history.getHistoryFromLatestBoundary(parentId)).toEqual(before);
  });

  test("fails creation rather than publishing a resumable snapshot if normalization fails", async () => {
    expect(
      (
        await harness.historyService.appendToHistory(
          parentId,
          createMuxMessage("unfinished", "assistant", "Working", { partial: true })
        )
      ).success
    ).toBe(true);
    const update = spyOn(harness.historyService, "updateHistory").mockResolvedValueOnce(
      Err("disk full")
    );
    try {
      expect((await harness.service.createSideChat(parentId)).success).toBe(false);
      expect(sideChatIdsOf(parentId)).toEqual([]);
      expect(config.findWorkspace(parentId)).not.toBeNull();
    } finally {
      update.mockRestore();
    }
  });

  test.each(["removed", "moved", "pending removal", "pending archive", "archived"] as const)(
    "registration refuses when another backend leaves the parent %s before the config write",
    async (change) => {
      const otherConfig = new Config(config.rootDir);
      const edit = config.editConfig.bind(config);
      const add = config.addWorkspace.bind(config);
      let registering = false;
      const registration = spyOn(config, "addWorkspace").mockImplementation((...args) => {
        registering = true;
        return add(...args);
      });
      const sideId = "aabbcc0011";
      const stableId = spyOn(config, "generateStableId").mockReturnValue(sideId);
      // Interleave after addWorkspace is entered, but before its serialized callback sees the
      // fresh config. A check in createSideChat (or before editConfig) is already stale here.
      const commit = spyOn(config, "editConfig").mockImplementation(async (...args) => {
        if (!registering) return edit(...args);
        registering = false;
        await otherConfig.editConfig((current) => {
          const project = current.projects.get(projectPath)!;
          const parent = project.workspaces.find((row) => row.id === parentId)!;
          const marker = {
            instanceId: "other-backend",
            pid: process.pid,
            identity: { ...getSelfIdentity() },
            at: new Date().toISOString(),
          };
          switch (change) {
            case "removed":
              project.workspaces = project.workspaces.filter((row) => row.id !== parentId);
              break;
            case "moved":
              parent.path = `${parentPath}-renamed`;
              break;
            case "pending removal":
              parent.pendingRemoval = { ...marker, removalId: "other-removal" };
              break;
            case "pending archive":
              parent.pendingArchive = { ...marker, archiveId: "other-archive" };
              break;
            case "archived":
              parent.archivedAt = new Date().toISOString();
              break;
          }
          return current;
        });
        return edit(...args);
      });
      try {
        const created = await harness.service.createSideChat(parentId);
        expect(registration).toHaveBeenCalled();
        expect(created.success).toBe(false);
        expect(otherConfig.findWorkspace(sideId)).toBeNull();
        expect(sideChatIdsOf(parentId)).toEqual([]);
        expect(existsSync(path.join(config.sessionsDir, sideId))).toBe(false);
      } finally {
        commit.mockRestore();
        registration.mockRestore();
        stableId.mockRestore();
      }
    }
  );

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

  test("removing the parent removes all its side chats", async () => {
    const sideChatIds = [await createSideChatOk(parentId), await createSideChatOk(parentId)];

    const removed = await harness.service.remove(parentId, true);

    expect(removed.success).toBe(true);
    expect(config.findWorkspace(parentId)).toBeNull();
    for (const sideChatId of sideChatIds) {
      expect(config.findWorkspace(sideChatId)).toBeNull();
      expect(existsSync(path.join(config.sessionsDir, sideChatId))).toBe(false);
    }
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

  test("archiving the parent removes all side chats and keeps the checkout", async () => {
    await config.editConfig((cfg) => ({ ...cfg, worktreeArchiveBehavior: "keep" }));
    const sideChatIds = [await createSideChatOk(parentId), await createSideChatOk(parentId)];

    const archived = await harness.service.archive(parentId);

    expect(archived).toEqual({ success: true, data: { kind: "archived" } });
    for (const sideChatId of sideChatIds) {
      expect(config.findWorkspace(sideChatId)).toBeNull();
      expect(existsSync(path.join(config.sessionsDir, sideChatId))).toBe(false);
    }
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

  test.each(["normal", "already-locked", "archive-while-locked"] as const)(
    "%s parent cleanup discards its side chat without reacquiring a tree lock",
    async (entrypoint) => {
      const sideChatId = await createSideChatOk(parentId);
      let locked = false;
      // Task-tree locks are not reentrant. Model this contract explicitly instead of hanging
      // the test if a nested side-chat removal mistakenly acquires the tree owner's lock again.
      const integration = makeAgentTaskIntegrationFake({
        withTaskTreeLifecycleLock: async <T>(
          _id: string,
          operation: () => Promise<T>
        ): Promise<T> => {
          if (locked) throw new Error("Task-tree lock reacquired");
          locked = true;
          try {
            return await operation();
          } finally {
            locked = false;
          }
        },
      });
      harness.service.setAgentTaskIntegration(integration);

      const result =
        entrypoint === "normal"
          ? await harness.service.remove(parentId, true)
          : await integration.withTaskTreeLifecycleLock(parentId, async () =>
              entrypoint === "already-locked"
                ? await harness.service.removeWhileTaskTreeLocked(parentId, true)
                : await harness.service.archiveWhileTaskTreeLocked(parentId)
            );

      expect(result.success).toBe(true);
      if (entrypoint === "archive-while-locked") {
        expect(config.findWorkspace(parentId)).not.toBeNull();
      } else {
        expect(config.findWorkspace(parentId)).toBeNull();
      }
      expect(config.findWorkspace(sideChatId)).toBeNull();
      expect(existsSync(path.join(config.sessionsDir, sideChatId))).toBe(false);
    }
  );

  test("a side chat follows its parent's renamed checkout and publishes the new path", async () => {
    const sideChatId = await createSideChatOk(parentId);
    const sidePaths: Array<string | undefined> = [];
    harness.service.on(
      "metadata",
      (event: { workspaceId: string; metadata: FrontendWorkspaceMetadata | null }) => {
        if (event.workspaceId === sideChatId) sidePaths.push(event.metadata?.namedWorkspacePath);
      }
    );
    const persistedPaths: Array<[string, string | undefined]> = [];
    const unsubscribe = config.onConfigChanged(() => {
      const owner = config.findWorkspace(parentId);
      if (owner?.workspaceName === "renamed-parent") {
        persistedPaths.push([owner.workspacePath, config.findWorkspace(sideChatId)?.workspacePath]);
      }
    });
    try {
      const renamed = await harness.service.rename(parentId, "renamed-parent");
      if (!renamed.success) throw new Error(renamed.error);
      const parent = config.findWorkspace(parentId);
      if (parent == null) throw new Error("renamed parent missing");
      expect(parent.workspacePath).not.toBe(parentPath);
      expect(persistedPaths.length).toBeGreaterThan(0);
      expect(persistedPaths.every(([ownerPath, sidePath]) => ownerPath === sidePath)).toBe(true);
      const side = await harness.service.getInfo(sideChatId);
      if (side == null) throw new Error("side chat missing after parent rename");
      expect(side.namedWorkspacePath).toBe(parent.workspacePath);
      expect(sidePaths).toContain(parent.workspacePath);
      expect(
        await fsPromises.readFile(path.join(side.namedWorkspacePath, "README.md"), "utf-8")
      ).toBe(await fsPromises.readFile(path.join(parent.workspacePath, "README.md"), "utf-8"));

      expect((await harness.service.remove(sideChatId, true)).success).toBe(true);
      expect(existsSync(path.join(parent.workspacePath, "README.md"))).toBe(true);
    } finally {
      unsubscribe();
    }
  });

  test("startup preserves existing idle side chats and their histories", async () => {
    const sideChatIds = [await createSideChatOk(parentId), await createSideChatOk(parentId)];
    // Deterministically older than startup, as in saved tabs from a previous process.
    await config.editConfig((cfg) => {
      for (const row of cfg.projects.get(projectPath)!.workspaces) {
        if (sideChatIds.includes(row.id ?? "")) row.createdAt = "2000-01-01T00:00:00.000Z";
      }
      return cfg;
    });
    const restarted = createWorkspaceServiceForTest({
      config,
      historyService: harness.historyService,
      aiService: harness.aiService,
      backgroundProcessManager: harness.backgroundProcessManager,
    });
    try {
      await restarted.initialize();
      // Join real idle recovery and transient-session disposal, rather than asserting while
      // background startup work could still change the persisted conversations.
      // eslint-disable-next-line @typescript-eslint/dot-notation -- private member, typed access
      await Promise.all(restarted["pendingWorkspaceCleanup"]);

      expect(sideChatIdsOf(parentId)).toEqual(sideChatIds);
      for (const id of sideChatIds) {
        expect(await restarted.getInfo(id)).not.toBeNull();
        expect(await historyIds(id)).toEqual(["parent-u1", "parent-a1"]);
        expect(existsSync(path.join(config.sessionsDir, id))).toBe(true);
      }
    } finally {
      restarted.beginShutdown();
      // eslint-disable-next-line @typescript-eslint/dot-notation -- private member, typed access
      await Promise.all(restarted["pendingWorkspaceCleanup"]);
    }
  });

  test("copies the parent's backend agent and model overrides", async () => {
    const settings = {
      agentId: "custom-agent",
      aiSettings: { model: "openai:gpt-4o", thinkingLevel: "high", reasoningMode: "pro" },
      aiSettingsByAgent: {
        "custom-agent": {
          model: "anthropic:claude-sonnet-4-5",
          thinkingLevel: "medium",
          autoModelRouting: true,
          autoThinkingLevel: true,
        },
        plan: { model: "openai:gpt-4o-mini", thinkingLevel: "low" },
      },
    } satisfies Pick<FrontendWorkspaceMetadata, "agentId" | "aiSettings" | "aiSettingsByAgent">;
    const parent = await config.getWorkspaceMetadataById(parentId);
    if (parent == null) throw new Error("parent metadata missing");
    await config.addWorkspace(projectPath, { ...parent, ...settings });

    const created = await harness.service.createSideChat(parentId);
    if (!created.success) throw new Error(created.error);
    expect(created.data.metadata).toMatchObject(settings);
    expect(await harness.service.getInfo(created.data.metadata.id)).toMatchObject(settings);
    expect(await config.getWorkspaceMetadataById(created.data.metadata.id)).toMatchObject(settings);
  });

  test("refuses side-chat attachment staging without changing the parent's uploaded files", async () => {
    const bytes = Buffer.from("attachment contents");
    const input = {
      filename: "notes.txt",
      mediaType: "text/plain",
      sizeBytes: bytes.length,
      dataBase64: bytes.toString("base64"),
    };
    const parentUpload = await harness.service.stageAttachment({ ...input, workspaceId: parentId });
    if (!parentUpload.success) throw new Error(parentUpload.error);
    const uploadDirectory = path.join(parentPath, STAGED_ATTACHMENT_DIR);
    const uploadsBefore = await fsPromises.readdir(uploadDirectory);
    const sideChatId = await createSideChatOk(parentId);

    const sideUpload = await harness.service.stageAttachment({ ...input, workspaceId: sideChatId });

    expect(sideUpload.success).toBe(false);
    expect(await fsPromises.readdir(uploadDirectory)).toEqual(uploadsBefore);
    expect(
      existsSync(path.join(config.sessionsDir, sideChatId, STAGED_ATTACHMENT_MIRROR_DIR_NAME))
    ).toBe(false);
    expect((await harness.service.remove(sideChatId, true)).success).toBe(true);
    expect(await fsPromises.readFile(path.join(parentPath, parentUpload.data.stagedPath))).toEqual(
      bytes
    );
  });

  test("opening another side chat never tries to discard an existing one", async () => {
    const first = await createSideChatOk(parentId);
    const service = harness.service;
    const realRemove = service.removeWhileTaskTreeLocked.bind(service);
    const removeSpy = spyOn(service, "removeWhileTaskTreeLocked").mockImplementation(
      (workspaceId, ...rest) =>
        workspaceId === first ? Promise.resolve(Err("in use")) : realRemove(workspaceId, ...rest)
    );
    try {
      const second = await service.createSideChat(parentId);

      expect(second.success).toBe(true);
      expect(removeSpy).not.toHaveBeenCalled();
      if (!second.success) throw new Error(second.error);
      expect(sideChatIdsOf(parentId)).toEqual([first, second.data.metadata.id]);
    } finally {
      removeSpy.mockRestore();
    }
  });
});
