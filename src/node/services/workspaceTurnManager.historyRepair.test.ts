import * as path from "path";
import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import * as fsPromises from "fs/promises";
import * as os from "os";
import { TerminalAttentionStore } from "@/node/services/terminalAttentionStore";
import {
  TaskHandleStore,
  type WorkspaceTurnTaskHandleRecord,
} from "@/node/services/taskHandleStore";
import { ForegroundWaitBackgroundedError } from "@/node/services/taskService";
import {
  createWorkspaceTurnManagerHarness,
  startWorkspaceTurnForTest,
} from "@/node/services/workspaceTurnManager.testHarness";
import type { ErrorEvent } from "@/common/types/stream";
import { createMuxMessage } from "@/common/types/message";
import {
  buildPlanReviewMetadata,
  formatPlanReviewEnvelope,
} from "@/common/utils/planReview/planReviewEnvelope";
import assert from "node:assert";
import {
  createTestConfig,
  projectWorkspace,
  saveLocalParentWorkspace,
  saveWorkspaces,
  stubStableIds,
  testTaskSettings,
  workspaceTurnRecord,
  workspaceTurnSnapshot,
} from "@/node/services/taskService.testHarness";

describe("WorkspaceTurnManager", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mux-taskService-"));
  });

  afterEach(async () => {
    await fsPromises.rm(rootDir, { recursive: true, force: true });
  });

  test("getWorkspaceTurnSnapshot repairs a stale error handle from self-healed history", async () => {
    const { config, parentId, taskService, taskHost, historyService } =
      await startWorkspaceTurnForTest(rootDir);
    await config.editConfig((cfg) => {
      const child = Array.from(cfg.projects.values())
        .flatMap((project) => project.workspaces)
        .find((workspace) => workspace.id === "childworkspace");
      assert(child, "workspace-turn child must exist");
      child.parentWorkspaceId = parentId;
      child.agentId = "exec";
      child.agentType = "exec";
      child.taskStatus = "reported";
      return cfg;
    });
    const patchGeneration = spyOn(
      taskHost,
      "maybeStartPatchGenerationForReportedTask"
    ).mockResolvedValue(undefined);
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    const appendResult = await historyService.appendToHistory(
      "childworkspace",
      createMuxMessage("msg_selfhealed", "assistant", "Self-healed final text", {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata,
      })
    );
    expect(appendResult.success).toBe(true);
    await new TaskHandleStore(config).upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, "childworkspace", "wst_handle", "error", {
        createdWorkspace: true,
        directParentResultDeliveryRequiredAt: "2026-06-19T00:00:01.500Z",
        directParentResultDeliveredAt: "2026-06-19T00:00:01.750Z",
        error: "Stream error: provider overloaded",
      })
    );

    expect(
      (
        await historyService.appendToHistory(
          parentId,
          createMuxMessage(
            "stale-direct-parent-failure",
            "user",
            [
              "<mux_subagent_failure>",
              "<task_id>childworkspace</task_id>",
              "<execution_version>wst_handle:error:2026-06-19T00:00:01.000Z</execution_version>",
              "<execution_id>wst_handle</execution_id>",
              "<agent_type>explore</agent_type>",
              "<error_type>workspace_turn_error</error_type>",
              "<error_message>",
              "Stream error: provider overloaded",
              "</error_message>",
              "</mux_subagent_failure>",
            ].join("\n"),
            { timestamp: Date.now(), synthetic: true, uiVisible: true }
          )
        )
      ).success
    ).toBe(true);

    const terminalAttentionStore = new TerminalAttentionStore(config);
    const staleAttention = await terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: parentId,
      sourceKind: "agent_task",
      sourceId: "childworkspace",
      generationId: "wst_handle:error:2026-06-19T00:00:01.000Z",
      createdAt: "2026-06-19T00:00:01.750Z",
    });
    assert(staleAttention, "stale direct-parent attention must exist");
    await terminalAttentionStore.markDelivered(parentId, staleAttention.id);

    // List paths skip history repair for settled handles (no runtime activity), so the
    // stale record stays visible there until a snapshot read reconciles it.
    const listed = await taskService.listWorkspaceTurnTasks(parentId, {
      statuses: ["error"],
    });
    expect(listed.map((record) => record.handleId)).toContain("wst_handle");

    const snapshot = await workspaceTurnSnapshot(taskService, parentId);
    expect(snapshot).toMatchObject({
      status: "completed",
      messageId: "msg_selfhealed",
      reportMarkdown: "Self-healed final text",
    });
    expect(patchGeneration).toHaveBeenCalledWith("childworkspace", {
      refreshForContinuation: true,
    });
    const deliveredSnapshot = await new TaskHandleStore(config).getWorkspaceTurn(
      parentId,
      "wst_handle"
    );
    expect(deliveredSnapshot?.directParentResultDeliveryRequiredAt).toBeDefined();
    expect(deliveredSnapshot?.directParentResultDeliveredAt).toBeDefined();
    expect(deliveredSnapshot?.directParentResultDeliveredAt).not.toBe("2026-06-19T00:00:01.750Z");
    const parentHistory = await historyService.getHistoryFromLatestBoundary(parentId);
    expect(JSON.stringify(parentHistory)).toContain("Stream error: provider overloaded");
    expect(JSON.stringify(parentHistory)).toContain("wst_handle:completed:");
    expect(JSON.stringify(parentHistory)).toContain("Self-healed final text");
    assert(deliveredSnapshot, "repaired terminal record must exist");
    const correctedGenerationId = `${deliveredSnapshot.handleId}:${deliveredSnapshot.status}:${deliveredSnapshot.updatedAt}`;
    expect(
      await terminalAttentionStore.get(
        parentId,
        TerminalAttentionStore.notificationId("agent_task", "childworkspace", correctedGenerationId)
      )
    ).not.toBeNull();
    expect(await terminalAttentionStore.get(parentId, staleAttention.id)).toBeNull();
    expect(snapshot?.error).toBeUndefined();
  });

  test("direct-parent snapshot consumption suppresses replay of a history-repaired outcome", async () => {
    const { config, parentId, taskService, historyService } =
      await startWorkspaceTurnForTest(rootDir);
    await config.editConfig((cfg) => {
      const child = Array.from(cfg.projects.values())
        .flatMap((project) => project.workspaces)
        .find((workspace) => workspace.id === "childworkspace");
      assert(child, "workspace-turn child must exist");
      child.parentWorkspaceId = parentId;
      child.agentId = "explore";
      child.agentType = "explore";
      child.taskStatus = "reported";
      return cfg;
    });
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    expect(
      (
        await historyService.appendToHistory(
          "childworkspace",
          createMuxMessage("msg_consumed_repair", "assistant", "Consumed repaired result", {
            model: "anthropic:claude-opus-4-6",
            agentId: "exec",
            finishReason: "stop",
            muxMetadata,
          })
        )
      ).success
    ).toBe(true);
    await new TaskHandleStore(config).upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, "childworkspace", "wst_handle", "error", {
        createdWorkspace: true,
        directParentResultDeliveryRequiredAt: "2026-06-19T00:00:01.500Z",
        directParentResultDeliveredAt: "2026-06-19T00:00:01.750Z",
        error: "Stream error: provider overloaded",
      })
    );

    const snapshot = await taskService.getWorkspaceTurnSnapshot(parentId, "wst_handle", {
      consumingWorkspaceId: parentId,
    });
    expect(snapshot).toMatchObject({
      status: "completed",
      messageId: "msg_consumed_repair",
      reportMarkdown: "Consumed repaired result",
    });
    expect(snapshot?.directParentResultDeliveredAt).toBeDefined();
    expect(snapshot?.directParentResultDeliveredAt).not.toBe("2026-06-19T00:00:01.750Z");

    const parentHistory = await historyService.getHistoryFromLatestBoundary(parentId);
    expect(parentHistory.success).toBe(true);
    expect(JSON.stringify(parentHistory)).not.toContain("Consumed repaired result");
    assert(snapshot, "repaired terminal record must exist");
    const correctedGenerationId = `${snapshot.handleId}:${snapshot.status}:${snapshot.updatedAt}`;
    expect(
      await new TerminalAttentionStore(config).get(
        parentId,
        TerminalAttentionStore.notificationId("agent_task", "childworkspace", correctedGenerationId)
      )
    ).toBeNull();
  });

  test("direct-parent repair consumption marks a concurrent terminal winner before replay", async () => {
    const { config, parentId, taskService, historyService } =
      await startWorkspaceTurnForTest(rootDir);
    await config.editConfig((cfg) => {
      const child = Array.from(cfg.projects.values())
        .flatMap((project) => project.workspaces)
        .find((workspace) => workspace.id === "childworkspace");
      assert(child, "workspace-turn child must exist");
      child.parentWorkspaceId = parentId;
      child.agentId = "explore";
      child.agentType = "explore";
      child.taskStatus = "reported";
      return cfg;
    });
    const staleRecord: WorkspaceTurnTaskHandleRecord = {
      kind: "workspace_turn",
      handleId: "wst_handle",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn",
      status: "error",
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:01.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
      directParentResultDeliveryRequiredAt: "2026-06-19T00:00:01.500Z",
      directParentResultDeliveredAt: "2026-06-19T00:00:01.750Z",
      error: "Stream error: provider overloaded",
    };
    const concurrentWinner: WorkspaceTurnTaskHandleRecord = {
      ...staleRecord,
      status: "completed",
      updatedAt: "2026-06-19T00:00:02.000Z",
      reportMarkdown: "Concurrent corrected result",
      messageId: "msg_concurrent_corrected",
      directParentResultDeliveryRequiredAt: "2026-06-19T00:00:02.000Z",
    };
    delete concurrentWinner.directParentResultDeliveredAt;
    delete concurrentWinner.error;
    const taskHandleStore = new TaskHandleStore(config);
    await taskHandleStore.upsertWorkspaceTurn(concurrentWinner);

    const internal = taskService as unknown as {
      persistRepairedSettledWorkspaceTurn: (
        record: WorkspaceTurnTaskHandleRecord,
        recovered: WorkspaceTurnTaskHandleRecord,
        options: { consumingWorkspaceId?: string }
      ) => Promise<WorkspaceTurnTaskHandleRecord | null>;
      deliverPersistentChildWorkspaceTurnResult: (
        record: WorkspaceTurnTaskHandleRecord,
        waiterWorkspaceIds: ReadonlySet<string>
      ) => Promise<void>;
    };
    const observed = await internal.persistRepairedSettledWorkspaceTurn(
      staleRecord,
      {
        ...staleRecord,
        status: "completed",
        updatedAt: "2026-06-19T00:00:03.000Z",
        reportMarkdown: "Losing history repair",
      },
      { consumingWorkspaceId: parentId }
    );
    expect(observed).toMatchObject({
      status: "completed",
      messageId: "msg_concurrent_corrected",
      reportMarkdown: "Concurrent corrected result",
    });
    expect(observed?.directParentResultDeliveredAt).toBeDefined();

    await internal.deliverPersistentChildWorkspaceTurnResult(concurrentWinner, new Set());
    const parentHistory = await historyService.getHistoryFromLatestBoundary(parentId);
    expect(parentHistory.success).toBe(true);
    expect(JSON.stringify(parentHistory)).not.toContain("Concurrent corrected result");
    const generationId = `${concurrentWinner.handleId}:${concurrentWinner.status}:${concurrentWinner.updatedAt}`;
    expect(
      await new TerminalAttentionStore(config).get(
        parentId,
        TerminalAttentionStore.notificationId("agent_task", "childworkspace", generationId)
      )
    ).toBeNull();
  });

  test("direct-parent consumption preserves a higher continuation owner's terminal wake", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["ownerpreservehandle", "ownerpreserveturn"]);
    const { parentId: rootWorkspaceId, projectPath } = await saveLocalParentWorkspace(
      config,
      rootDir
    );
    const directParentTaskId = "direct-parent-preserve-owner-wake";
    const childTaskId = "child-preserve-owner-wake";
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId),
        projectWorkspace(projectPath, "direct-parent", directParentTaskId, {
          parentWorkspaceId: rootWorkspaceId,
          agentId: "exec",
          agentType: "exec",
          taskStatus: "running",
        }),
        projectWorkspace(projectPath, "child", childTaskId, {
          parentWorkspaceId: directParentTaskId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "reported",
          title: "Owner Wake Reviewer",
        }),
      ],
      testTaskSettings()
    );
    const { taskService } = createWorkspaceTurnManagerHarness(config);
    const created = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: rootWorkspaceId,
      prompt: "Continue work owned by the root ancestor.",
      title: "Owner Wake Reviewer",
      allowAgentWorkspace: true,
      attentionPolicy: "notify_on_terminal",
      workspace: { mode: "existing", workspaceId: childTaskId },
    });
    expect(created.success).toBe(true);
    if (!created.success) return;
    const taskHandleStore = new TaskHandleStore(config);
    const active = await taskHandleStore.getWorkspaceTurn(rootWorkspaceId, created.data.taskId);
    assert(active, "continuation record must exist");
    const terminal: WorkspaceTurnTaskHandleRecord = {
      ...active,
      status: "completed",
      updatedAt: "2026-08-11T00:00:02.000Z",
      reportMarkdown: "Higher owner result",
      directParentResultDeliveryRequiredAt: "2026-08-11T00:00:02.000Z",
      directParentResultDeliveredAt: "2026-08-11T00:00:02.500Z",
    };
    await taskHandleStore.upsertWorkspaceTurn(terminal);
    const terminalAttentionStore = new TerminalAttentionStore(config);
    await terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: rootWorkspaceId,
      sourceKind: "workspace_turn",
      sourceId: terminal.handleId,
      terminalOutcome: "completed",
    });

    const consumed = await taskService.getWorkspaceTurnSnapshot(
      rootWorkspaceId,
      terminal.handleId,
      {
        consumingWorkspaceId: directParentTaskId,
      }
    );
    expect(consumed?.directParentResultDeliveredAt).toBe("2026-08-11T00:00:02.500Z");
    expect(consumed?.terminalAttentionNotifiedAt).toBeUndefined();
    await taskService.markWorkspaceTurnTerminalAttentionConsumed({
      ownerWorkspaceId: rootWorkspaceId,
      consumingWorkspaceId: directParentTaskId,
      handleId: terminal.handleId,
      updatedAt: terminal.updatedAt,
      status: terminal.status,
    });
    expect(
      await terminalAttentionStore.get(
        rootWorkspaceId,
        TerminalAttentionStore.notificationId("workspace_turn", terminal.handleId)
      )
    ).toMatchObject({ status: "pending" });
  });

  test("getWorkspaceTurnSnapshot revives an interrupted handle while the child retries the same turn", async () => {
    const hasPendingAutoRetry = mock((workspaceId: string) => workspaceId === "childworkspace");
    const { config, parentId, taskService, historyService } = await startWorkspaceTurnForTest(
      rootDir,
      {
        hasPendingAutoRetry,
      }
    );
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    const appendResult = await historyService.appendToHistory(
      "childworkspace",
      createMuxMessage("msg_prompt", "user", "Summarize", { muxMetadata })
    );
    expect(appendResult.success).toBe(true);
    await new TaskHandleStore(config).upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, "childworkspace", "wst_handle", "interrupted", {
        createdWorkspace: true,
        directParentResultDeliveryRequiredAt: "2026-06-19T00:00:01.500Z",
        directParentResultDeliveredAt: "2026-06-19T00:00:01.750Z",
        error: "Workspace turn interrupted after restart",
        terminalAttentionNotifiedAt: "2026-06-19T00:00:02.000Z",
      })
    );
    // Delivered tombstone from the stale settlement; revive must clear it so the revived
    // turn's eventual real settlement can enqueue a fresh wake-up.
    const terminalAttentionStore = new TerminalAttentionStore(config);
    await terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: parentId,
      sourceKind: "workspace_turn",
      sourceId: "wst_handle",
    });
    await terminalAttentionStore.markDelivered(parentId, "workspace_turn:wst_handle");
    const internal = taskService as unknown as {
      activeWorkspaceTurnHandleByWorkspaceId: Map<
        string,
        { handleId: string; ownerWorkspaceId: string; accepted: boolean }
      >;
    };
    internal.activeWorkspaceTurnHandleByWorkspaceId.clear();

    const snapshot = await workspaceTurnSnapshot(taskService, parentId);
    expect(snapshot).toMatchObject({ status: "running", workspaceId: "childworkspace" });
    expect(snapshot?.directParentResultDeliveryRequiredAt).toBeUndefined();
    expect(snapshot?.directParentResultDeliveredAt).toBeUndefined();
    expect(snapshot?.error).toBeUndefined();
    expect(snapshot?.terminalAttentionNotifiedAt).toBeUndefined();
    expect(await terminalAttentionStore.get(parentId, "workspace_turn:wst_handle")).toBeNull();
    // Revival registers as accepted: the revived turn was already admitted once, so peer
    // admission and delegated correlation may treat it as live immediately.
    expect(internal.activeWorkspaceTurnHandleByWorkspaceId.get("childworkspace")).toEqual({
      handleId: "wst_handle",
      ownerWorkspaceId: parentId,
      accepted: true,
    });
  });

  test("history repair of a stale error handle waits for active child background work", async () => {
    const { config, parentId, projectPath, taskService, historyService } =
      await startWorkspaceTurnForTest(rootDir);
    // The retried turn emitted its correlated final while a descendant task was still
    // running; reporting completed before it finishes would hand the parent an
    // incomplete result that active handles avoid via deferred stream-ends. Instead the
    // handle is revived with the final recorded as deferred, then settles once the
    // blocker is gone.
    await config.editConfig((cfg) => {
      const project = Array.from(cfg.projects.values())[0];
      assert(project, "test project must exist");
      project.workspaces.push({
        path: path.join(projectPath, "descendant-task"),
        id: "descendant-task",
        name: "descendant-task",
        createdAt: "2026-06-19T00:00:00.000Z",
        runtimeConfig: { type: "local" },
        parentWorkspaceId: "childworkspace",
        taskStatus: "running",
      });
      return cfg;
    });
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    expect(
      (
        await historyService.appendToHistory(
          "childworkspace",
          createMuxMessage("msg_blocked_final", "assistant", "Blocked final text", {
            model: "anthropic:claude-opus-4-6",
            agentId: "exec",
            finishReason: "stop",
            muxMetadata,
          })
        )
      ).success
    ).toBe(true);
    await new TaskHandleStore(config).upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, "childworkspace", "wst_handle", "error", {
        createdWorkspace: true,
        error: "Stream error: provider overloaded",
      })
    );

    const blocked = await workspaceTurnSnapshot(taskService, parentId);
    expect(blocked).toMatchObject({
      status: "running",
      deferredMessageIds: ["msg_blocked_final"],
    });
    expect(blocked?.error).toBeUndefined();
    expect(blocked?.reportMarkdown).toBeUndefined();

    await config.editConfig((cfg) => {
      const descendant = Array.from(cfg.projects.values())
        .flatMap((project) => project.workspaces)
        .find((workspace) => workspace.id === "descendant-task");
      assert(descendant, "descendant task must exist");
      descendant.archivedAt = "2026-06-19T00:01:00.000Z";
      return cfg;
    });

    expect(await workspaceTurnSnapshot(taskService, parentId)).toMatchObject({
      status: "completed",
      messageId: "msg_blocked_final",
      reportMarkdown: "Blocked final text",
    });
  });

  test("turn-end blocker scan keeps a stale handle live between retry streams via child blockers", async () => {
    const { config, parentId, projectPath, taskService, historyService } =
      await startWorkspaceTurnForTest(rootDir);
    // Codex handoff gap: the retried child's stream ended, no auto-retry is pending, but
    // its descendant work is still running. The blocker scan must still treat the turn as
    // live so the parent cannot end its turn during that window.
    await config.editConfig((cfg) => {
      const project = Array.from(cfg.projects.values())[0];
      assert(project, "test project must exist");
      project.workspaces.push({
        path: path.join(projectPath, "descendant-task"),
        id: "descendant-task",
        name: "descendant-task",
        createdAt: "2026-06-19T00:00:00.000Z",
        runtimeConfig: { type: "local" },
        parentWorkspaceId: "childworkspace",
        taskStatus: "running",
      });
      return cfg;
    });
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    expect(
      (
        await historyService.appendToHistory(
          "childworkspace",
          createMuxMessage("msg_prompt", "user", "Summarize", { muxMetadata })
        )
      ).success
    ).toBe(true);
    await new TaskHandleStore(config).upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, "childworkspace", "wst_handle", "error", {
        createdWorkspace: true,
        error: "Stream error: provider overloaded",
      })
    );
    const internal = taskService as unknown as {
      activeWorkspaceTurnHandleByWorkspaceId: Map<
        string,
        { handleId: string; ownerWorkspaceId: string }
      >;
      listActiveWorkspaceTurnTaskIdsForOwner: (ownerWorkspaceId: string) => Promise<string[]>;
    };
    internal.activeWorkspaceTurnHandleByWorkspaceId.clear();

    expect(await internal.listActiveWorkspaceTurnTaskIdsForOwner(parentId)).toContain("wst_handle");
    expect(await workspaceTurnSnapshot(taskService, parentId)).toMatchObject({
      status: "running",
      workspaceId: "childworkspace",
    });
  });

  test("turn-end blocker scan revives and includes a stale retrying handle", async () => {
    const hasPendingAutoRetry = mock((workspaceId: string) => workspaceId === "childworkspace");
    const { config, parentId, taskService, historyService } = await startWorkspaceTurnForTest(
      rootDir,
      {
        hasPendingAutoRetry,
      }
    );
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    expect(
      (
        await historyService.appendToHistory(
          "childworkspace",
          createMuxMessage("msg_prompt", "user", "Summarize", { muxMetadata })
        )
      ).success
    ).toBe(true);
    await new TaskHandleStore(config).upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, "childworkspace", "wst_handle", "error", {
        createdWorkspace: true,
        error: "Stream error: provider overloaded",
      })
    );
    const internal = taskService as unknown as {
      activeWorkspaceTurnHandleByWorkspaceId: Map<
        string,
        { handleId: string; ownerWorkspaceId: string }
      >;
      listActiveWorkspaceTurnTaskIdsForOwner: (ownerWorkspaceId: string) => Promise<string[]>;
    };
    internal.activeWorkspaceTurnHandleByWorkspaceId.clear();

    // The parent turn-end path must treat the stale-but-retrying handle as live work so
    // the parent cannot end its turn while the child is still running.
    expect(await internal.listActiveWorkspaceTurnTaskIdsForOwner(parentId)).toContain("wst_handle");
    expect(await workspaceTurnSnapshot(taskService, parentId)).toMatchObject({
      status: "running",
      workspaceId: "childworkspace",
    });
  });

  test("active-only listWorkspaceTurnTasks revives and includes a stale retrying handle", async () => {
    const hasPendingAutoRetry = mock((workspaceId: string) => workspaceId === "childworkspace");
    const { config, parentId, taskService, historyService } = await startWorkspaceTurnForTest(
      rootDir,
      {
        hasPendingAutoRetry,
      }
    );
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    expect(
      (
        await historyService.appendToHistory(
          "childworkspace",
          createMuxMessage("msg_prompt", "user", "Summarize", { muxMetadata })
        )
      ).success
    ).toBe(true);
    await new TaskHandleStore(config).upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, "childworkspace", "wst_handle", "error", {
        createdWorkspace: true,
        error: "Stream error: provider overloaded",
      })
    );
    const internal = taskService as unknown as {
      activeWorkspaceTurnHandleByWorkspaceId: Map<
        string,
        { handleId: string; ownerWorkspaceId: string }
      >;
    };
    internal.activeWorkspaceTurnHandleByWorkspaceId.clear();

    // task_list defaults to active statuses; the status filter applies AFTER
    // normalization, so the stale-but-retrying handle is revived and reported as
    // running instead of silently disappearing from the active view.
    const listed = await taskService.listWorkspaceTurnTasks(parentId, {
      statuses: ["queued", "starting", "running"],
    });
    expect(listed.map((record) => record.handleId)).toContain("wst_handle");
    expect(listed.find((record) => record.handleId === "wst_handle")?.status).toBe("running");
  });

  test("queued manual input does not revive a settled workspace turn", async () => {
    // Ordinary queued input is not yet in history, so the newest-correlated-prompt guard
    // cannot see it; the liveness gate must not treat it as a same-turn continuation.
    const hasQueuedMessages = mock((workspaceId: string) => workspaceId === "childworkspace");
    const hasPendingQueuedOrPreparingTurn = mock(
      (workspaceId: string) => workspaceId === "childworkspace"
    );
    const { config, parentId, taskService, historyService } = await startWorkspaceTurnForTest(
      rootDir,
      {
        hasQueuedMessages,
        hasPendingQueuedOrPreparingTurn,
      }
    );
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    expect(
      (
        await historyService.appendToHistory(
          "childworkspace",
          createMuxMessage("msg_prompt", "user", "Summarize", { muxMetadata })
        )
      ).success
    ).toBe(true);
    await new TaskHandleStore(config).upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, "childworkspace", "wst_handle", "error", {
        createdWorkspace: true,
        error: "Stream error: provider overloaded",
      })
    );
    const internal = taskService as unknown as {
      activeWorkspaceTurnHandleByWorkspaceId: Map<
        string,
        { handleId: string; ownerWorkspaceId: string }
      >;
      listActiveWorkspaceTurnTaskIdsForOwner: (ownerWorkspaceId: string) => Promise<string[]>;
    };
    internal.activeWorkspaceTurnHandleByWorkspaceId.clear();

    expect(await internal.listActiveWorkspaceTurnTaskIdsForOwner(parentId)).not.toContain(
      "wst_handle"
    );
    expect(await workspaceTurnSnapshot(taskService, parentId)).toMatchObject({
      status: "error",
      error: "Stream error: provider overloaded",
    });
  });

  test("a newer unrelated child prompt does not revive a settled workspace turn", async () => {
    const isStreaming = mock((workspaceId: string) => workspaceId === "childworkspace");
    const { config, parentId, taskService, historyService } = await startWorkspaceTurnForTest(
      rootDir,
      {
        isStreaming,
      }
    );
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    expect(
      (
        await historyService.appendToHistory(
          "childworkspace",
          createMuxMessage("msg_prompt", "user", "Summarize", { muxMetadata })
        )
      ).success
    ).toBe(true);
    expect(
      (
        await historyService.appendToHistory(
          "childworkspace",
          createMuxMessage("msg_manual", "user", "Manual follow-up", {})
        )
      ).success
    ).toBe(true);
    await new TaskHandleStore(config).upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, "childworkspace", "wst_handle", "error", {
        createdWorkspace: true,
        error: "Stream error: provider overloaded",
      })
    );
    const internal = taskService as unknown as {
      activeWorkspaceTurnHandleByWorkspaceId: Map<
        string,
        { handleId: string; ownerWorkspaceId: string }
      >;
    };
    internal.activeWorkspaceTurnHandleByWorkspaceId.clear();

    expect(await workspaceTurnSnapshot(taskService, parentId)).toMatchObject({
      status: "error",
      error: "Stream error: provider overloaded",
    });
  });

  test("a trailing hidden plan-review record does not block reviving a retrying workspace turn", async () => {
    // Plan-review resolve/reopen rows are persisted as `role: user` rows but are UI state, not
    // prompts (isModelHiddenMessage). Reconciliation must treat them like the absence of a row:
    // the correlated prompt is still the newest PROMPT, so the retrying child revives the handle.
    const hasPendingAutoRetry = mock((workspaceId: string) => workspaceId === "childworkspace");
    const { config, parentId, taskService, historyService } = await startWorkspaceTurnForTest(
      rootDir,
      {
        hasPendingAutoRetry,
      }
    );
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    expect(
      (
        await historyService.appendToHistory(
          "childworkspace",
          createMuxMessage("msg_prompt", "user", "Summarize", { muxMetadata })
        )
      ).success
    ).toBe(true);
    const resolve = {
      v: 1 as const,
      kind: "resolve" as const,
      recordId: "rec_1",
      threadId: "thr_1",
    };
    expect(
      (
        await historyService.appendToHistory(
          "childworkspace",
          createMuxMessage("msg_plan_review", "user", formatPlanReviewEnvelope(resolve), {
            synthetic: true,
            muxMetadata: buildPlanReviewMetadata(resolve),
          })
        )
      ).success
    ).toBe(true);
    await new TaskHandleStore(config).upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, "childworkspace", "wst_handle", "interrupted", {
        createdWorkspace: true,
        error: "Workspace turn interrupted after restart",
      })
    );
    const internal = taskService as unknown as {
      activeWorkspaceTurnHandleByWorkspaceId: Map<
        string,
        { handleId: string; ownerWorkspaceId: string }
      >;
    };
    internal.activeWorkspaceTurnHandleByWorkspaceId.clear();

    expect(await workspaceTurnSnapshot(taskService, parentId)).toMatchObject({
      status: "running",
      workspaceId: "childworkspace",
    });
  });

  test("revive does not clobber a newer same-status settlement written after the stale read", async () => {
    const { config, parentId, taskService } = await startWorkspaceTurnForTest(rootDir);
    const taskHandleStore = new TaskHandleStore(config);
    // The record currently on disk: a FRESH error settled by the live retry itself.
    const freshError = {
      kind: "workspace_turn" as const,
      handleId: "wst_handle",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn",
      status: "error" as const,
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:05:00.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
      error: "Stream error: retry also failed",
    };
    await taskHandleStore.upsertWorkspaceTurn(freshError);
    const internal = taskService as unknown as {
      reviveRetryingWorkspaceTurn: (record: typeof freshError) => Promise<typeof freshError | null>;
    };

    // Reconcile observed an OLDER error record (same status, earlier updatedAt) before the
    // retry failed; the revive must notice the newer settlement and leave it untouched.
    const revived = await internal.reviveRetryingWorkspaceTurn({
      ...freshError,
      updatedAt: "2026-06-19T00:00:01.000Z",
      error: "Stream error: provider overloaded",
    });

    expect(revived).toMatchObject({
      status: "error",
      updatedAt: "2026-06-19T00:05:00.000Z",
      error: "Stream error: retry also failed",
    });
    expect(await taskHandleStore.getWorkspaceTurn(parentId, "wst_handle")).toMatchObject({
      status: "error",
      updatedAt: "2026-06-19T00:05:00.000Z",
      error: "Stream error: retry also failed",
    });
  });

  test("history repair scans past newer unrelated prompts to a correlated final message", async () => {
    const { config, parentId, taskService, historyService } =
      await startWorkspaceTurnForTest(rootDir);
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    // The turn self-healed and finished, THEN the child received an unrelated manual
    // prompt before the parent ever called task_await.
    expect(
      (
        await historyService.appendToHistory(
          "childworkspace",
          createMuxMessage("msg_selfhealed_final", "assistant", "Self-healed final text", {
            model: "anthropic:claude-opus-4-6",
            agentId: "exec",
            finishReason: "stop",
            muxMetadata,
          })
        )
      ).success
    ).toBe(true);
    expect(
      (
        await historyService.appendToHistory(
          "childworkspace",
          createMuxMessage("msg_manual_later", "user", "Manual follow-up", {})
        )
      ).success
    ).toBe(true);
    await new TaskHandleStore(config).upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, "childworkspace", "wst_handle", "error", {
        createdWorkspace: true,
        error: "Stream error: provider overloaded",
      })
    );

    const snapshot = await workspaceTurnSnapshot(taskService, parentId);
    expect(snapshot).toMatchObject({
      status: "completed",
      messageId: "msg_selfhealed_final",
      reportMarkdown: "Self-healed final text",
    });
    expect(snapshot?.error).toBeUndefined();
  });

  test("waitForWorkspaceTurn foreground waits can be sent to background", async () => {
    const { parentId, taskService, taskHost } = await startWorkspaceTurnForTest(rootDir);

    const waitResult = taskService
      .waitForWorkspaceTurn("wst_handle", {
        requestingWorkspaceId: parentId,
        timeoutMs: 1_000,
        backgroundOnMessageQueued: true,
      })
      .then(
        () => null,
        (error: unknown) => error
      );

    expect(taskHost.backgroundForegroundWaitsForWorkspace(parentId)).toBe(1);
    expect(await waitResult).toBeInstanceOf(ForegroundWaitBackgroundedError);
    expect(taskHost.backgroundForegroundWaitsForWorkspace(parentId)).toBe(0);
  });

  test("waitForWorkspaceTurn backgrounds when tool-end message was already queued", async () => {
    const hasQueuedMessages = mock(() => true);
    const { parentId, taskService, taskHost } = await startWorkspaceTurnForTest(rootDir, {
      hasQueuedMessages,
    });

    const waitError = await taskService
      .waitForWorkspaceTurn("wst_handle", {
        requestingWorkspaceId: parentId,
        timeoutMs: 1_000,
        backgroundOnMessageQueued: true,
      })
      .catch((error: unknown) => error);

    expect(waitError).toBeInstanceOf(ForegroundWaitBackgroundedError);
    expect(hasQueuedMessages).toHaveBeenCalledWith(parentId, "tool-end");
    expect(taskHost.backgroundForegroundWaitsForWorkspace(parentId)).toBe(0);
  });

  for (const scenario of [
    {
      name: "workspace-turn stream errors mark the handle failed",
      event: {
        type: "error",
        workspaceId: "childworkspace",
        messageId: "msg_1",
        error: "Provider failed",
        errorType: "authentication",
      } satisfies ErrorEvent,
    },
    {
      name: "workspace-turn terminal stream errors mark the handle failed",
      event: {
        type: "error",
        workspaceId: "childworkspace",
        messageId: "msg_unknown_error",
        error: "Provider returned no usable result",
        errorType: "unknown",
      } satisfies ErrorEvent,
      clearRegistration: true,
    },
    {
      name: "workspace-turn auto-retryable stream errors without a pending retry mark the handle failed",
      event: {
        type: "error",
        workspaceId: "childworkspace",
        messageId: "msg_truncated_exhausted",
        error: "Anthropic stream closed unexpectedly before the response completed.",
        errorType: "stream_truncated",
      } satisfies ErrorEvent,
    },
    // Codex review: unrelated queued manual messages must not keep the handle
    // running for auto-retryable errors — they start a different turn, so the
    // failed turn would never resume. Only an actual pending auto-retry counts.
    {
      name: "workspace-turn auto-retryable stream errors with only queued messages mark the handle failed",
      event: {
        type: "error",
        workspaceId: "childworkspace",
        messageId: "msg_truncated_queued_only",
        error: "Anthropic stream closed unexpectedly before the response completed.",
        errorType: "stream_truncated",
      } satisfies ErrorEvent,
      queuedOnly: true,
    },
    {
      name: "workspace-turn exhausted recoverable stream errors mark the handle failed",
      event: {
        type: "error",
        workspaceId: "childworkspace",
        messageId: "msg_exhausted_context",
        error: "Context still too large after retry",
        errorType: "context_exceeded",
      } satisfies ErrorEvent,
    },
    // Terminal provider rejection of replayed reasoning: StreamManager already
    // spent its one in-stream repair, so even a pending retry must not keep the
    // parent's handle running.
    {
      name: "workspace-turn reasoning_rejected stream errors mark the handle failed despite a pending retry",
      event: {
        type: "error",
        workspaceId: "childworkspace",
        messageId: "msg_reasoning_rejected",
        error: "The encrypted content for item rs_1 could not be verified.",
        errorType: "reasoning_rejected",
      } satisfies ErrorEvent,
      retryPending: true,
    },
  ]) {
    test(scenario.name, async () => {
      const hasPendingQueuedOrPreparingTurn = scenario.queuedOnly ? mock(() => true) : undefined;
      const hasPendingAutoRetry = scenario.queuedOnly
        ? mock(() => false)
        : scenario.retryPending
          ? mock(() => true)
          : undefined;
      const { parentId, taskService } = await startWorkspaceTurnForTest(rootDir, {
        ...(hasPendingQueuedOrPreparingTurn != null ? { hasPendingQueuedOrPreparingTurn } : {}),
        ...(hasPendingAutoRetry != null ? { hasPendingAutoRetry } : {}),
      });
      if (scenario.clearRegistration === true) {
        (
          taskService as unknown as {
            activeWorkspaceTurnHandleByWorkspaceId: Map<string, unknown>;
          }
        ).activeWorkspaceTurnHandleByWorkspaceId.clear();
      }

      await taskService.finalizeWorkspaceTurnFromStreamError(scenario.event);

      expect(await workspaceTurnSnapshot(taskService, parentId)).toMatchObject({
        status: "error",
        workspaceId: "childworkspace",
        error: scenario.event.error,
      });
    });
  }

  for (const scenario of [
    {
      name: "workspace-turn recoverable stream errors stay running while retry is pending",
      event: {
        type: "error",
        workspaceId: "childworkspace",
        messageId: "msg_1",
        error: "Context too large",
        errorType: "context_exceeded",
      } satisfies ErrorEvent,
      pending: "queued" as const,
    },
    // Regression: stream_truncated (a transient provider drop) previously fell
    // outside the recoverable allowlist and terminally settled the handle even
    // though the child session had already scheduled an in-session auto-retry,
    // falsely reporting the turn as failed to the parent.
    {
      name: "workspace-turn auto-retryable stream errors stay running while retry is pending",
      event: {
        type: "error",
        workspaceId: "childworkspace",
        messageId: "msg_truncated",
        error: "Anthropic stream closed unexpectedly before the response completed.",
        errorType: "stream_truncated",
      } satisfies ErrorEvent,
      pending: "auto" as const,
    },
  ]) {
    test(scenario.name, async () => {
      let retryDecisionAwaited = false;
      const pending = mock(
        (workspaceId: string) => retryDecisionAwaited && workspaceId === "childworkspace"
      );
      const waitForPendingStreamErrorRecoveryDecision = mock((): Promise<void> => {
        retryDecisionAwaited = true;
        return Promise.resolve();
      });
      const { parentId, taskService } = await startWorkspaceTurnForTest(rootDir, {
        ...(scenario.pending === "queued"
          ? { hasPendingQueuedOrPreparingTurn: pending }
          : { hasPendingAutoRetry: pending }),
        waitForPendingStreamErrorRecoveryDecision,
      });

      await taskService.finalizeWorkspaceTurnFromStreamError(scenario.event);

      expect(waitForPendingStreamErrorRecoveryDecision).toHaveBeenCalledWith(
        "childworkspace",
        scenario.event.messageId
      );
      expect(await workspaceTurnSnapshot(taskService, parentId)).toMatchObject({
        status: "running",
        workspaceId: "childworkspace",
      });
    });
  }

  test("terminal recovery skips legacy delivery records and contains per-record replay failures", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    const childTaskId = "child-terminal-delivery-recovery";
    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath);
      assert(project, "test project must exist");
      project.workspaces.push(
        projectWorkspace(projectPath, "child", childTaskId, {
          parentWorkspaceId: parentId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "reported",
        })
      );
      return cfg;
    });
    const { taskService } = createWorkspaceTurnManagerHarness(config);
    const taskHandleStore = (taskService as unknown as { taskHandleStore: TaskHandleStore })
      .taskHandleStore;
    const baseRecord = {
      kind: "workspace_turn" as const,
      ownerWorkspaceId: parentId,
      workspaceId: childTaskId,
      status: "completed" as const,
      createdAt: "2026-08-11T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:01.000Z",
      createdWorkspace: false,
      disposableWorkspace: false,
      reportMarkdown: "Recovered result",
    };
    await taskHandleStore.upsertWorkspaceTurn({
      ...baseRecord,
      handleId: "wst_legacy_delivery",
      turnId: "legacy-delivery",
    });
    await taskHandleStore.upsertWorkspaceTurn({
      ...baseRecord,
      handleId: "wst_required_delivery",
      turnId: "required-delivery",
      directParentResultDeliveryRequiredAt: "2026-08-11T00:00:01.000Z",
    });
    const internal = taskService as unknown as {
      deliverPersistentChildWorkspaceTurnResult: (
        record: WorkspaceTurnTaskHandleRecord,
        waiterWorkspaceIds: ReadonlySet<string>
      ) => Promise<void>;
      recoverTerminalWorkspaceTurnAttentionNotifications: () => Promise<number>;
    };
    // Reject only when recovery invokes the fault, after its asynchronous disk scan.
    const replay = spyOn(
      internal,
      "deliverPersistentChildWorkspaceTurnResult"
    ).mockImplementationOnce(() => Promise.reject(new Error("read-only session")));

    try {
      await internal.recoverTerminalWorkspaceTurnAttentionNotifications();
      expect(replay).toHaveBeenCalledTimes(1);
      expect(replay.mock.calls[0]?.[0].handleId).toBe("wst_required_delivery");
    } finally {
      replay.mockRestore();
    }
  });

  test("terminal recovery contains per-record attention persistence failures", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const { taskService, taskHost } = createWorkspaceTurnManagerHarness(config);
    const taskHandleStore = new TaskHandleStore(config);
    for (const [index, handleId] of ["wst_attention_failure", "wst_attention_success"].entries()) {
      await taskHandleStore.upsertWorkspaceTurn(
        workspaceTurnRecord(parentId, parentId, handleId, "completed", {
          turnId: `attention-recovery-${index}`,
          createdAt: "2026-08-11T00:00:00.000Z",
          updatedAt: `2026-08-11T00:00:0${index + 1}.000Z`,
          attentionPolicy: "notify_on_terminal",
          reportMarkdown: `Recovered result ${index}`,
        })
      );
    }
    const internal = taskService as unknown as {
      recoverTerminalWorkspaceTurnAttentionNotifications: () => Promise<number>;
    };
    const enqueueTerminalAttention = taskHost.enqueueTerminalAttention.bind(taskHost);
    const enqueue = spyOn(taskHost, "enqueueTerminalAttention")
      .mockImplementation(enqueueTerminalAttention)
      .mockImplementationOnce(() => Promise.reject(new Error("read-only attention store")));

    try {
      expect(await internal.recoverTerminalWorkspaceTurnAttentionNotifications()).toBe(1);
      expect(enqueue).toHaveBeenCalledTimes(2);
    } finally {
      enqueue.mockRestore();
    }
    const records = await taskHandleStore.listWorkspaceTurns(parentId);
    expect(records.filter((record) => record.terminalAttentionNotifiedAt != null)).toHaveLength(1);
  });
});
