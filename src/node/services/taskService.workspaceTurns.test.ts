import * as path from "path";
import { describe, test, expect, mock, spyOn, beforeEach, afterEach } from "bun:test";
import * as fsPromises from "fs/promises";
import { execSync } from "node:child_process";
import {
  getSubagentGitPatchMboxPath,
  readSubagentGitPatchArtifact,
  upsertSubagentGitPatchArtifact,
} from "@/node/services/subagentGitPatchArtifacts";
import { TerminalAttentionStore } from "@/node/services/terminalAttentionStore";
import {
  TaskHandleStore,
  type WorkspaceTurnTaskHandleRecord,
} from "@/node/services/taskHandleStore";
import { WorkflowRunStore } from "@/node/services/workflows/WorkflowRunStore";
import { recordAgentWorkflowRunReference } from "@/node/services/agentWorkflowRunReferences";
import { Ok, Err, type Result } from "@/common/types/result";
import type { SendMessageError } from "@/common/types/errors";
import type { StreamEndEvent } from "@/common/types/stream";
import { createMuxMessage } from "@/common/types/message";
import assert from "node:assert";
import {
  createAIServiceMocks,
  createTestConfig,
  createWorkspaceServiceMocks,
  makeWorkspaceTurnCreateMock,
  findWorkspaceInConfig,
  initGitRepo,
  projectWorkspace,
  saveLocalParentWorkspace,
  saveWorkspaces,
  streamAbort,
  streamEnd,
  streamError,
  stubStableIds,
  testTaskSettings,
  workspaceTurnManagerFor,
  workspaceTurnManagerInternals,
  workspaceTurnMuxMetadata,
  workspaceTurnRecord,
  workspaceTurnSnapshot,
  workspaceTurnStreamEndEvent,
} from "@/node/services/taskService.testHarness";
import {
  createTaskServiceHarness,
  flushTerminalAttentionDrains,
  createTaskServiceTestRoot,
  removeTaskServiceTestRoot,
  startWorkspaceTurnForTest,
} from "@/node/services/taskService.shared.testHarness";

describe("TaskService", () => {
  let rootDir: string;
  beforeEach(async () => {
    rootDir = await createTaskServiceTestRoot();
  });
  afterEach(async () => {
    await removeTaskServiceTestRoot(rootDir);
  });

  test("continuation settlement delivers a stable child report and suppresses the private wake", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["continuationreporthandle", "continuationreportturn"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    const childWorkspaceId = "reported-child-continuation-result";
    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath);
      assert(project, "test project must exist");
      project.workspaces.push(
        projectWorkspace(projectPath, "reported-child", childWorkspaceId, {
          parentWorkspaceId: parentId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "reported",
          reportedAt: "2026-08-10T00:00:00.000Z",
          title: "Tooling Mapper",
        })
      );
      return cfg;
    });
    const sendMessage = mock(async (...args: unknown[]): Promise<Result<void>> => {
      const internal = args[3] as { onAccepted?: () => Promise<void> | void } | undefined;
      await internal?.onAccepted?.();
      return Ok(undefined);
    });
    const resumeStream = mock(
      (): Promise<Result<{ started: boolean }>> => Promise.resolve(Ok({ started: true }))
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage, resumeStream });
    const { historyService, taskService } = createTaskServiceHarness(config, { workspaceService });

    const created = await workspaceTurnManagerFor(taskService).createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Map the remaining tooling surface.",
      title: "Tooling Mapper",
      allowAgentWorkspace: true,
      attentionPolicy: "notify_on_terminal",
      workspace: { mode: "existing", workspaceId: childWorkspaceId },
    });
    expect(created).toMatchObject({ success: true, data: { workspaceId: childWorkspaceId } });
    if (!created.success) return;

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childWorkspaceId,
      messageId: "msg-continuation-result",
      metadata: {
        model: "anthropic:claude-sonnet-4-6",
        agentId: "explore",
        finishReason: "stop",
        muxMetadata: workspaceTurnMuxMetadata(
          parentId,
          created.data.taskId,
          "continuationreportturn"
        ),
      },
      parts: [{ type: "text", text: "Mapped the tooling surface." }],
    });
    await flushTerminalAttentionDrains(taskService);

    const parentHistory = await historyService.getHistoryFromLatestBoundary(parentId);
    expect(parentHistory.success).toBe(true);
    expect(JSON.stringify(parentHistory)).toContain("<mux_subagent_report>");
    expect(JSON.stringify(parentHistory)).toContain(childWorkspaceId);
    expect(JSON.stringify(parentHistory)).toContain("Mapped the tooling surface.");
    expect(
      sendMessage.mock.calls.some(
        (call) =>
          call[0] === parentId &&
          typeof call[1] === "string" &&
          call[1].includes("Background workspace turn(s) have reached a terminal state")
      )
    ).toBe(false);
    expect(resumeStream).toHaveBeenCalledWith(
      parentId,
      expect.any(Object),
      expect.objectContaining({ agentInitiated: true })
    );

    const taskHandleStore = new TaskHandleStore(config);
    const terminalRecord = await taskHandleStore.getWorkspaceTurn(parentId, created.data.taskId);
    assert(terminalRecord, "terminal continuation record must exist");
    const attentionGenerationId = `${terminalRecord.handleId}:${terminalRecord.status}:${terminalRecord.updatedAt}`;
    const attentionStore = new TerminalAttentionStore(config);
    expect(
      await attentionStore.get(
        parentId,
        TerminalAttentionStore.notificationId("agent_task", childWorkspaceId, attentionGenerationId)
      )
    ).toMatchObject({ status: "delivered" });
    expect(
      await attentionStore.get(
        parentId,
        TerminalAttentionStore.notificationId(
          "workspace_turn",
          created.data.taskId,
          attentionGenerationId
        )
      )
    ).toMatchObject({ status: "superseded" });
    const recordWithoutDeliveryMarker = { ...terminalRecord };
    delete recordWithoutDeliveryMarker.directParentResultDeliveredAt;
    await taskHandleStore.upsertWorkspaceTurn(recordWithoutDeliveryMarker);
    await (
      workspaceTurnManagerFor(taskService) as unknown as {
        recoverTerminalWorkspaceTurnAttentionNotifications: () => Promise<number>;
      }
    ).recoverTerminalWorkspaceTurnAttentionNotifications();
    await flushTerminalAttentionDrains(taskService);

    const recoveredHistory = await historyService.getHistoryFromLatestBoundary(parentId);
    expect(JSON.stringify(recoveredHistory).match(/Mapped the tooling surface\./g)).toHaveLength(1);
    expect(
      (await taskHandleStore.getWorkspaceTurn(parentId, created.data.taskId))
        ?.directParentResultDeliveredAt
    ).toBeDefined();
  });

  test("exec continuation refreshes the stable child patch artifact from the last applied head", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["execcontinuationhandle", "execcontinuationturn"]);
    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-exec-continuation";
    const childId = "child-exec-continuation";
    const parentPath = path.join(projectPath, "parent");
    const childPath = path.join(projectPath, "child");
    await fsPromises.mkdir(parentPath, { recursive: true });
    await fsPromises.mkdir(childPath, { recursive: true });

    initGitRepo(childPath);
    const launchBaseCommitSha = execSync("git rev-parse HEAD", {
      cwd: childPath,
      encoding: "utf-8",
    }).trim();
    execSync("bash -lc 'echo \"first\" >> README.md'", { cwd: childPath, stdio: "ignore" });
    execSync("git add README.md", { cwd: childPath, stdio: "ignore" });
    execSync('git commit -m "first child change"', { cwd: childPath, stdio: "ignore" });
    const firstPatchHeadSha = execSync("git rev-parse HEAD", {
      cwd: childPath,
      encoding: "utf-8",
    }).trim();

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId, {
          runtimeConfig: { type: "local" },
        }),
        projectWorkspace(projectPath, "child", childId, {
          parentWorkspaceId: parentId,
          agentId: "exec",
          agentType: "exec",
          taskStatus: "reported",
          reportedAt: "2026-08-18T00:00:00.000Z",
          runtimeConfig: { type: "local" },
          taskBaseCommitSha: launchBaseCommitSha,
        }),
      ],
      testTaskSettings()
    );

    const parentSessionDir = path.join(config.sessionsDir, parentId);
    await upsertSubagentGitPatchArtifact({
      workspaceId: parentId,
      workspaceSessionDir: parentSessionDir,
      childTaskId: childId,
      updater: () => ({
        childTaskId: childId,
        parentWorkspaceId: parentId,
        createdAtMs: 1,
        updatedAtMs: 2,
        status: "ready",
        projectArtifacts: [
          {
            projectPath,
            projectName: "repo",
            storageKey: "repo",
            status: "ready",
            baseCommitSha: launchBaseCommitSha,
            headCommitSha: firstPatchHeadSha,
            commitCount: 1,
            mboxPath: getSubagentGitPatchMboxPath(parentSessionDir, childId, "repo"),
            appliedAtMs: 3,
          },
        ],
        readyProjectCount: 1,
        failedProjectCount: 0,
        skippedProjectCount: 0,
        totalCommitCount: 1,
      }),
    });

    const sendMessage = mock(async (...args: unknown[]): Promise<Result<void>> => {
      const internal = args[3] as { onAccepted?: () => Promise<void> | void } | undefined;
      await internal?.onAccepted?.();
      return Ok(undefined);
    });
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    const continuation = await workspaceTurnManagerFor(taskService).createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Make the follow-up fix.",
      title: "Exec continuation",
      allowAgentWorkspace: true,
      workspace: { mode: "existing", workspaceId: childId },
    });
    expect(continuation.success).toBe(true);
    if (!continuation.success) return;

    execSync("bash -lc 'echo \"second\" >> README.md'", { cwd: childPath, stdio: "ignore" });
    execSync("git add README.md", { cwd: childPath, stdio: "ignore" });
    execSync('git commit -m "second continuation change"', { cwd: childPath, stdio: "ignore" });
    const continuationHeadSha = execSync("git rev-parse HEAD", {
      cwd: childPath,
      encoding: "utf-8",
    }).trim();

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "msg-exec-continuation-result",
      metadata: {
        model: "test-model",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata: workspaceTurnMuxMetadata(
          parentId,
          continuation.data.taskId,
          "execcontinuationturn"
        ),
      },
      parts: [{ type: "text", text: "Implemented the follow-up fix." }],
    });

    const patchPath = getSubagentGitPatchMboxPath(parentSessionDir, childId, "repo");
    const startedAt = Date.now();
    let artifact = await readSubagentGitPatchArtifact(parentSessionDir, childId);
    while (artifact?.status === "pending") {
      if (Date.now() - startedAt > 20_000) {
        throw new Error(`Timed out waiting for continuation patch: ${JSON.stringify(artifact)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
      artifact = await readSubagentGitPatchArtifact(parentSessionDir, childId);
    }

    expect(artifact?.status).toBe("ready");
    expect(artifact?.projectArtifacts[0]).toMatchObject({
      baseCommitSha: firstPatchHeadSha,
      headCommitSha: continuationHeadSha,
      commitCount: 1,
    });
    const patch = await fsPromises.readFile(patchPath, "utf-8");
    expect(patch).toContain("Subject: [PATCH] second continuation change");
    expect(patch).not.toContain("Subject: [PATCH] first child change");
  }, 20_000);

  test("higher-ancestor waiters do not suppress continuation delivery to the direct parent", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["nestedwaiterhandle", "nestedwaiterturn"]);
    const { parentId: rootWorkspaceId, projectPath } = await saveLocalParentWorkspace(
      config,
      rootDir
    );
    const directParentTaskId = "direct-parent-continuation-result";
    const childTaskId = "nested-child-continuation-result";
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
          reportedAt: "2026-08-10T00:00:00.000Z",
          title: "Nested Reviewer",
        }),
      ],
      testTaskSettings()
    );
    const sendMessage = mock(async (...args: unknown[]): Promise<Result<void>> => {
      const internal = args[3] as { onAccepted?: () => Promise<void> | void } | undefined;
      await internal?.onAccepted?.();
      return Ok(undefined);
    });
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { historyService, taskService } = createTaskServiceHarness(config, { workspaceService });

    const created = await workspaceTurnManagerFor(taskService).createWorkspaceTurn({
      ownerWorkspaceId: directParentTaskId,
      prompt: "Continue the nested review.",
      title: "Nested Reviewer",
      allowAgentWorkspace: true,
      attentionPolicy: "notify_on_terminal",
      workspace: { mode: "existing", workspaceId: childTaskId },
    });
    expect(created.success).toBe(true);
    if (!created.success) return;

    const waited = workspaceTurnManagerFor(taskService).waitForWorkspaceTurn(created.data.taskId, {
      requestingWorkspaceId: rootWorkspaceId,
      ownerWorkspaceId: directParentTaskId,
      timeoutMs: 5_000,
    });
    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childTaskId,
      messageId: "msg-nested-continuation-result",
      metadata: {
        model: "anthropic:claude-sonnet-4-6",
        agentId: "explore",
        finishReason: "stop",
        muxMetadata: workspaceTurnMuxMetadata(
          directParentTaskId,
          created.data.taskId,
          "nestedwaiterturn"
        ),
      },
      parts: [{ type: "text", text: "Nested review complete." }],
    });
    expect(await waited).toMatchObject({ reportMarkdown: "Nested review complete." });

    const directParentHistory =
      await historyService.getHistoryFromLatestBoundary(directParentTaskId);
    expect(JSON.stringify(directParentHistory)).toContain("Nested review complete.");
    expect(JSON.stringify(directParentHistory)).toContain(childTaskId);
  });

  test("a direct-parent foreground waiter does not suppress the continuation owner's wake", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["ownerwaiterhandle", "ownerwaiterturn"]);
    const { parentId: rootWorkspaceId, projectPath } = await saveLocalParentWorkspace(
      config,
      rootDir
    );
    const directParentTaskId = "direct-parent-owner-wake";
    const childTaskId = "nested-child-owner-wake";
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
    const sendMessage = mock(async (...args: unknown[]): Promise<Result<void>> => {
      const internal = args[3] as { onAccepted?: () => Promise<void> | void } | undefined;
      await internal?.onAccepted?.();
      return Ok(undefined);
    });
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    const created = await workspaceTurnManagerFor(taskService).createWorkspaceTurn({
      ownerWorkspaceId: rootWorkspaceId,
      prompt: "Continue the root-owned nested review.",
      title: "Owner Wake Reviewer",
      allowAgentWorkspace: true,
      attentionPolicy: "notify_on_terminal",
      workspace: { mode: "existing", workspaceId: childTaskId },
    });
    expect(created.success).toBe(true);
    if (!created.success) return;

    const waited = workspaceTurnManagerFor(taskService).waitForWorkspaceTurn(created.data.taskId, {
      requestingWorkspaceId: directParentTaskId,
      ownerWorkspaceId: rootWorkspaceId,
      timeoutMs: 5_000,
    });
    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childTaskId,
      messageId: "msg-owner-wake-result",
      metadata: {
        model: "anthropic:claude-sonnet-4-6",
        agentId: "explore",
        finishReason: "stop",
        muxMetadata: workspaceTurnMuxMetadata(
          rootWorkspaceId,
          created.data.taskId,
          "ownerwaiterturn"
        ),
      },
      parts: [{ type: "text", text: "Root-owned nested review complete." }],
    });
    expect(await waited).toMatchObject({ reportMarkdown: "Root-owned nested review complete." });
    await flushTerminalAttentionDrains(taskService);

    // The direct parent consumed the result through its waiter, so the distinct continuation
    // owner must retain terminal attention (pending until idle, or already delivered).
    const terminalRecord = await new TaskHandleStore(config).getWorkspaceTurn(
      rootWorkspaceId,
      created.data.taskId
    );
    assert(terminalRecord, "terminal continuation record must exist");
    const ownerAttention = await new TerminalAttentionStore(config).get(
      rootWorkspaceId,
      TerminalAttentionStore.notificationId(
        "workspace_turn",
        created.data.taskId,
        `${terminalRecord.handleId}:${terminalRecord.status}:${terminalRecord.updatedAt}`
      )
    );
    expect(ownerAttention).toMatchObject({
      sourceKind: "workspace_turn",
      sourceId: created.data.taskId,
    });
    assert(ownerAttention, "continuation owner attention must remain persisted");
    expect(["pending", "delivered"]).toContain(ownerAttention.status);
  });

  test("workspace-turn stream-end finalizes the handle without agent_report semantics", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["handle", "turn"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);

    const createWorkspace = makeWorkspaceTurnCreateMock(config, projectPath);
    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const created = await workspaceTurnManagerFor(taskService).createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Summarize",
      title: "Workspace turn",
      workspace: { mode: "new" },
    });
    expect(created.success).toBe(true);

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_1",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata: workspaceTurnMuxMetadata(parentId),
      },
      parts: [
        // StreamManager stores provider text deltas as adjacent parts; concatenate them exactly.
        { type: "text", text: "## Verified" },
        { type: "text", text: " root" },
        { type: "text", text: " cause\n\n" },
        { type: "text", text: "- Fixed" },
        // Non-text parts separate rendered text runs and must remain a report block boundary.
        {
          type: "dynamic-tool",
          toolCallId: "call-1",
          toolName: "bash",
          input: { script: "true" },
          state: "output-available",
          output: { success: true },
        },
        { type: "text", text: "Follow-up" },
        { type: "text", text: " complete." },
      ],
    });

    const snapshot = await workspaceTurnSnapshot(taskService, parentId);
    expect(snapshot).toMatchObject({
      status: "completed",
      workspaceId: "childworkspace",
      messageId: "msg_1",
      reportMarkdown: "## Verified root cause\n\n- Fixed\n\nFollow-up complete.",
      finalMessageRef: { messageId: "msg_1", agentId: "exec", textCharCount: 50 },
    });
    const childConfig = findWorkspaceInConfig(config, "childworkspace");
    expect(childConfig?.parentWorkspaceId).toBeUndefined();
    expect(childConfig?.taskStatus).toBeUndefined();
  });

  test("notify_on_terminal workspace turn wakes the owner via task_await on completion", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["handle", "turn"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);

    // Register the child workspace the handle points at.
    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath);
      assert(project, "test project must exist");
      project.workspaces.push({
        path: path.join(projectPath, "workspace-turn"),
        id: "childworkspace",
        name: "workspace-turn",
        title: "Workspace turn",
        createdAt: "2026-06-19T00:00:00.000Z",
        runtimeConfig: { type: "local" },
      });
      return cfg;
    });

    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    const workspaceMocks = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const taskHandleStore = new TaskHandleStore(config);
    const createdAt = "2026-06-19T00:00:00.000Z";
    await taskHandleStore.upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, "childworkspace", "wst_handle", "running", {
        createdAt,
        updatedAt: createdAt,
        createdWorkspace: true,
        attentionPolicy: "notify_on_terminal",
      })
    );
    workspaceTurnManagerInternals(taskService).activeWorkspaceTurnHandleByWorkspaceId.set(
      "childworkspace",
      {
        handleId: "wst_handle",
        ownerWorkspaceId: parentId,
        accepted: false,
      }
    );

    const internal = taskService as unknown as {
      pendingTerminalAttentionDrains: Set<Promise<void>>;
    };
    await streamEnd(taskService, workspaceTurnStreamEndEvent(parentId, "msg_1", "Done"));

    // Drain runs asynchronously; await any in-flight drains before asserting.
    await Promise.all([...internal.pendingTerminalAttentionDrains]);

    const wakeCall = sendMessage.mock.calls.find(
      (call) => typeof call[1] === "string" && call[1].includes("wst_handle")
    );
    expect(wakeCall).toBeDefined();
    const prompt = wakeCall?.[1] as string;
    expect(prompt).toContain("task_await");
    expect(prompt).toContain("timeout_secs: 0");
    expect(wakeCall?.[3]).toMatchObject({ synthetic: true, requireIdle: true });

    // Restart-safe dedupe marker and the exact terminal outcome notification are persisted.
    const snapshot = await workspaceTurnSnapshot(taskService, parentId);
    expect(snapshot?.terminalAttentionNotifiedAt).toBeDefined();
    assert(snapshot, "terminal workspace-turn snapshot must exist");
    const attentionId = TerminalAttentionStore.notificationId(
      "workspace_turn",
      snapshot.handleId,
      `${snapshot.handleId}:${snapshot.status}:${snapshot.updatedAt}`
    );
    expect(await new TerminalAttentionStore(config).get(parentId, attentionId)).toMatchObject({
      status: "delivered",
    });
  });

  test("notify_on_terminal workspace turn defers wake-up while owner has a queued turn", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["handle", "turn"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);

    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath);
      assert(project, "test project must exist");
      project.workspaces.push({
        path: path.join(projectPath, "workspace-turn"),
        id: "childworkspace",
        name: "workspace-turn",
        title: "Workspace turn",
        createdAt: "2026-06-19T00:00:00.000Z",
        runtimeConfig: { type: "local" },
      });
      return cfg;
    });

    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    // Owner is preparing/queuing a user turn: terminal wake-up must NOT inject ahead of it.
    const hasPendingQueuedOrPreparingTurn = mock(() => true);
    const workspaceMocks = createWorkspaceServiceMocks({
      sendMessage,
      hasPendingQueuedOrPreparingTurn,
    });
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const taskHandleStore = new TaskHandleStore(config);
    const createdAt = "2026-06-19T00:00:00.000Z";
    await taskHandleStore.upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, "childworkspace", "wst_handle", "running", {
        createdAt,
        updatedAt: createdAt,
        createdWorkspace: true,
        attentionPolicy: "notify_on_terminal",
      })
    );
    workspaceTurnManagerInternals(taskService).activeWorkspaceTurnHandleByWorkspaceId.set(
      "childworkspace",
      {
        handleId: "wst_handle",
        ownerWorkspaceId: parentId,
        accepted: false,
      }
    );

    const internal = taskService as unknown as {
      pendingTerminalAttentionDrains: Set<Promise<void>>;
      drainTerminalAttention: (ownerWorkspaceId: string) => Promise<void>;
    };
    await streamEnd(taskService, workspaceTurnStreamEndEvent(parentId, "msg_1", "Done"));
    await Promise.all([...internal.pendingTerminalAttentionDrains]);

    // No wake-up sent while a queued/preparing turn exists.
    const wakeCall = sendMessage.mock.calls.find(
      (call) => typeof call[1] === "string" && call[1].includes("wst_handle")
    );
    expect(wakeCall).toBeUndefined();

    // Notification remains pending; once the owner is idle, draining delivers it.
    hasPendingQueuedOrPreparingTurn.mockImplementation(() => false);
    await internal.drainTerminalAttention(parentId);
    const drained = sendMessage.mock.calls.find(
      (call) => typeof call[1] === "string" && call[1].includes("wst_handle")
    );
    expect(drained).toBeDefined();
  });

  test("stuck pending outbox attention is re-poked by the sweep-cadence reconciler", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const terminalAttentionStore = new TerminalAttentionStore(config);
    await terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: parentId,
      sourceKind: "workspace_turn",
      sourceId: "wst_stuck",
    });

    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { historyService, taskService } = createTaskServiceHarness(config, { workspaceService });
    const internal = taskService as unknown as {
      drainTerminalAttention: (ownerWorkspaceId: string) => Promise<void>;
      schedulePendingTerminalAttentionOwnerDrains: () => Promise<number>;
    };

    // Transient restriction read failure: the drain fails closed, leaving the durable record
    // pending with no later stream or task event to retry it.
    const iterateSpy = spyOn(historyService, "iterateFullHistory")
      // Lazy rejection: an eager mockRejectedValueOnce promise trips bun's unhandled-rejection
      // detector on this host before the drain consumes it.
      .mockImplementationOnce(() => Promise.reject(new Error("EIO: history unreadable")));
    try {
      await internal.drainTerminalAttention(parentId);
      expect(sendMessage).not.toHaveBeenCalled();

      expect(await internal.schedulePendingTerminalAttentionOwnerDrains()).toBe(1);
      await flushTerminalAttentionDrains(taskService);
    } finally {
      iterateSpy.mockRestore();
    }
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(String(sendMessage.mock.calls[0]?.[1])).toContain("wst_stuck");
    expect(await terminalAttentionStore.get(parentId, "workspace_turn:wst_stuck")).toMatchObject({
      status: "delivered",
    });
  });

  test("a rejected non-workflow send backs off and lets an agent-bound group deliver", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const runId = "wfr_nonworkflow_backoff";
    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, parentId) });
    await runStore.createRun({
      id: runId,
      workspaceId: parentId,
      workflow: {
        name: "research",
        description: "Research workflow",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      attentionPolicy: "notify_on_terminal",
      now: "2026-06-19T00:00:00.000Z",
    });
    await runStore.appendStatus(runId, "running", "2026-06-19T00:00:01.000Z");
    await runStore.appendStatus(runId, "completed", "2026-06-19T00:00:03.000Z");

    // The workspace-turn batch's conversation-identity send is persistently rejected; the
    // agent-bound group's own pinned identity can still send.
    const sendMessage = mock((..._args: unknown[]): Promise<Result<void, SendMessageError>> => {
      const options = _args[2] as { agentId?: string } | undefined;
      return options?.agentId === "plan"
        ? Promise.resolve(Ok(undefined))
        : Promise.resolve(Err({ type: "unknown", raw: "agent not resolvable" }));
    });
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    (workspaceService as unknown as Record<string, unknown>).getWorkflowInvocationCurrentness =
      mock(() => Promise.resolve("current"));
    const { taskService, historyService } = createTaskServiceHarness(config, { workspaceService });

    await historyService.appendToHistory(
      parentId,
      createMuxMessage("manual", "user", "run the audit", { timestamp: 1_000 })
    );
    await recordAgentWorkflowRunReference({
      workspaceSessionDir: path.join(config.sessionsDir, parentId),
      runId,
      agentId: "plan",
    });

    // A deliverable (non-suppressed) workspace-turn wake keeps the agent-bound group out of
    // the batch until the batch's send is rejected.
    const taskHandleStore = new TaskHandleStore(config);
    await taskHandleStore.upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, parentId, "wst_backoff_deliverable", "completed", {
        turnId: "backoff-deliverable",
        reportMarkdown: "turn done",
        createdAt: "2026-08-11T00:00:00.000Z",
        updatedAt: "2026-08-11T00:00:01.000Z",
      })
    );
    const terminalAttentionStore = new TerminalAttentionStore(config);
    await terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: parentId,
      sourceKind: "workspace_turn",
      sourceId: "wst_backoff_deliverable",
    });
    (
      taskService as unknown as { pendingWorkflowRunAttention: Map<string, Set<string>> }
    ).pendingWorkflowRunAttention.set(parentId, new Set([runId]));

    await (
      taskService as unknown as {
        drainTerminalAttention: (ownerWorkspaceId: string) => Promise<void>;
      }
    ).drainTerminalAttention(parentId);
    await flushTerminalAttentionDrains(taskService);

    // First attempt sends the non-workflow batch and is rejected; the re-poked drain lets the
    // backed-off batch sit out so the agent-bound group delivers in the same cycle.
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[1]?.[2]).toMatchObject({ agentId: "plan" });
    expect(String(sendMessage.mock.calls[1]?.[1])).toContain(runId);
    // The rejected wake stays pending for the sweep-cadence retry, never dropped.
    const stillPending = await terminalAttentionStore.listPending(parentId);
    expect(stillPending.map((notification) => notification.sourceId)).toEqual([
      "wst_backoff_deliverable",
    ]);
    const queued = (
      taskService as unknown as { pendingWorkflowRunAttention: Map<string, Set<string>> }
    ).pendingWorkflowRunAttention.get(parentId);
    expect(queued?.has(runId) ?? false).toBe(false);
  });

  test("a fully suppressed batch re-pokes the drain for unselected workflow groups", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const runId = "wfr_repoke";
    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, parentId) });
    await runStore.createRun({
      id: runId,
      workspaceId: parentId,
      workflow: {
        name: "research",
        description: "Research workflow",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      attentionPolicy: "notify_on_terminal",
      now: "2026-06-19T00:00:00.000Z",
    });
    await runStore.appendStatus(runId, "running", "2026-06-19T00:00:01.000Z");
    await runStore.appendStatus(runId, "completed", "2026-06-19T00:00:03.000Z");

    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    (workspaceService as unknown as Record<string, unknown>).getWorkflowInvocationCurrentness =
      mock(() => Promise.resolve("current"));
    const { taskService, historyService } = createTaskServiceHarness(config, { workspaceService });
    const drain = (
      taskService as unknown as {
        drainTerminalAttention: (ownerWorkspaceId: string) => Promise<void>;
      }
    ).drainTerminalAttention.bind(taskService);

    await historyService.appendToHistory(
      parentId,
      createMuxMessage("manual", "user", "run the audit", { timestamp: 1_000 })
    );
    await recordAgentWorkflowRunReference({
      workspaceSessionDir: path.join(config.sessionsDir, parentId),
      runId,
      agentId: "exec",
    });

    // A pending workspace-turn notification whose handle already carries an owner-follow-up
    // supersede: the pre-suppression batch counts it (excluding the agent-bound workflow
    // group from the send), then the last-moment reread drops it, emptying the batch.
    const taskHandleStore = new TaskHandleStore(config);
    await taskHandleStore.upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, parentId, "wst_repoke_suppressed", "interrupted", {
        turnId: "repoke-suppressed",
        error:
          "Workspace turn superseded by follow-up turn wst_repoke_successor from the same owner workspace",
        createdAt: "2026-08-11T00:00:00.000Z",
        updatedAt: "2026-08-11T00:00:01.000Z",
      })
    );
    const terminalAttentionStore = new TerminalAttentionStore(config);
    await terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: parentId,
      sourceKind: "workspace_turn",
      sourceId: "wst_repoke_suppressed",
    });
    (
      taskService as unknown as { pendingWorkflowRunAttention: Map<string, Set<string>> }
    ).pendingWorkflowRunAttention.set(parentId, new Set([runId]));

    // The empty suppressed batch must re-poke the drain, not park the wake on the sweep.
    await drain(parentId);
    await flushTerminalAttentionDrains(taskService);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const prompt = String(sendMessage.mock.calls[0]?.[1]);
    expect(prompt).toContain(runId);
    expect(sendMessage.mock.calls[0]?.[2] as Record<string, unknown>).toMatchObject({
      agentId: "exec",
    });
    expect(await terminalAttentionStore.listPending(parentId)).toHaveLength(0);
  });

  test("initialize contains task execution reconciliation scan failures", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    // One child the reconciliation pass would adopt a handle for, and one stale `starting` child
    // that only the recovery steps AFTER the reconciliation pass repair.
    const reconcilableChildId = "child-reconcilable-execution";
    const staleStartingChildId = "child-stale-starting";
    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath);
      assert(project, "test project must exist");
      project.workspaces.push(
        projectWorkspace(projectPath, "child-reconcilable", reconcilableChildId, {
          parentWorkspaceId: parentId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "reported",
          reportedAt: "2026-08-10T00:00:00.000Z",
        }),
        projectWorkspace(projectPath, "child-stale-starting", staleStartingChildId, {
          parentWorkspaceId: parentId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "starting",
          taskPrompt: "Resume the investigation.",
        })
      );
      return cfg;
    });
    const isStreaming = mock((workspaceId: string) => workspaceId === reconcilableChildId);
    const { aiService } = createAIServiceMocks(config, { isStreaming });
    const { taskService } = createTaskServiceHarness(config, { aiService });
    await new TaskHandleStore(config).upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, reconcilableChildId, "wst_reconcilable", "running", {
        turnId: "turn-reconcilable",
        createdAt: "2026-08-10T00:00:01.000Z",
        updatedAt: "2026-08-10T00:00:01.000Z",
      })
    );
    const listAllWorkspaceTurns = spyOn(
      TaskHandleStore.prototype,
      "listAllWorkspaceTurns"
    ).mockRejectedValueOnce(new Error("permission denied"));

    let scanCalls: number;
    try {
      await taskService.initialize();
    } finally {
      // mockRestore() also clears the recorded calls.
      scanCalls = listAllWorkspaceTurns.mock.calls.length;
      listAllWorkspaceTurns.mockRestore();
    }

    // The injected scan failure reached the reconciliation pass, which skipped its adoption...
    expect(scanCalls).toBeGreaterThan(0);
    expect(findWorkspaceInConfig(config, reconcilableChildId)?.taskExecutionId).toBeUndefined();
    // ...and startup recovery still continued past it.
    expect(findWorkspaceInConfig(config, staleStartingChildId)?.taskStatus).not.toBe("starting");
  });

  test("initialize recovers an unreferenced persistent child execution handle", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    const childTaskId = "child-unreferenced-execution";
    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath);
      assert(project, "test project must exist");
      project.workspaces.push(
        projectWorkspace(projectPath, "child-unreferenced", childTaskId, {
          parentWorkspaceId: parentId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "reported",
          reportedAt: "2026-08-10T00:00:00.000Z",
          title: "React lifecycle expert",
        })
      );
      return cfg;
    });
    const isStreaming = mock((workspaceId: string) => workspaceId === childTaskId);
    const { aiService } = createAIServiceMocks(config, { isStreaming });
    const { taskService } = createTaskServiceHarness(config, { aiService });
    const taskHandleStore = new TaskHandleStore(config);
    await taskHandleStore.upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, childTaskId, "wst_unreferenced", "running", {
        turnId: "turn-unreferenced",
        createdAt: "2026-08-10T00:00:01.000Z",
        updatedAt: "2026-08-10T00:00:01.000Z",
        title: "React lifecycle expert",
        prompt: "Continue investigating.",
      })
    );

    await taskService.initialize();

    expect(findWorkspaceInConfig(config, childTaskId)?.taskExecutionId).toBe("wst_unreferenced");
    expect(findWorkspaceInConfig(config, childTaskId)?.taskExecutionStatus).toBe("running");
  });

  test.each(["completed", "running"] as const)(
    "initialize prefers a newer unreferenced execution over a stale %s child pointer",
    async (previousStatus) => {
      const config = await createTestConfig(rootDir);
      const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
      const childTaskId = "child-newer-execution";
      await config.editConfig((cfg) => {
        const project = cfg.projects.get(projectPath);
        assert(project, "test project must exist");
        project.workspaces.push(
          projectWorkspace(projectPath, "child-newer", childTaskId, {
            parentWorkspaceId: parentId,
            agentId: "explore",
            agentType: "explore",
            taskStatus: "reported",
            reportedAt: "2026-08-10T00:00:00.000Z",
            title: "React lifecycle expert",
            taskExecutionId: "wst_old",
            taskExecutionStatus: previousStatus,
          })
        );
        return cfg;
      });
      const isStreaming = mock((workspaceId: string) => workspaceId === childTaskId);
      const { aiService } = createAIServiceMocks(config, { isStreaming });
      const { taskService } = createTaskServiceHarness(config, { aiService });
      const taskHandleStore = new TaskHandleStore(config);
      await taskHandleStore.upsertWorkspaceTurn(
        workspaceTurnRecord(parentId, childTaskId, "wst_old", previousStatus, {
          turnId: "turn-old",
          createdAt: "2026-08-10T00:00:01.000Z",
          updatedAt: "2026-08-10T00:00:02.000Z",
        })
      );
      await taskHandleStore.upsertWorkspaceTurn(
        workspaceTurnRecord(parentId, childTaskId, "wst_new", "running", {
          turnId: "turn-new",
          createdAt: "2026-08-10T00:00:03.000Z",
          updatedAt: "2026-08-10T00:00:04.000Z",
        })
      );

      await taskService.initialize();

      expect(findWorkspaceInConfig(config, childTaskId)?.taskExecutionId).toBe("wst_new");
      expect(findWorkspaceInConfig(config, childTaskId)?.taskExecutionStatus).toBe("running");
    }
  );

  test("initialize ignores parseable non-ISO timestamps when selecting the latest handle", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    const childTaskId = "child-invalid-execution-timestamp";
    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath);
      assert(project, "test project must exist");
      project.workspaces.push(
        projectWorkspace(projectPath, "child-invalid-timestamp", childTaskId, {
          parentWorkspaceId: parentId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "reported",
          taskExecutionId: "wst_invalid_timestamp",
          taskExecutionStatus: "completed",
        })
      );
      return cfg;
    });
    const isStreaming = mock((workspaceId: string) => workspaceId === childTaskId);
    const { aiService } = createAIServiceMocks(config, { isStreaming });
    const { taskService } = createTaskServiceHarness(config, { aiService });
    const taskHandleStore = new TaskHandleStore(config);
    await taskHandleStore.upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, childTaskId, "wst_invalid_timestamp", "completed", {
        turnId: "turn-invalid-timestamp",
        createdAt: "2026-08-10T00:00:02.000Z",
        updatedAt: "9999",
      })
    );
    await taskHandleStore.upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, childTaskId, "wst_valid_timestamp", "running", {
        turnId: "turn-valid-timestamp",
        createdAt: "2026-08-10T00:00:00.000Z",
        updatedAt: "2026-08-10T00:00:01.000Z",
      })
    );

    await taskService.initialize();

    expect(findWorkspaceInConfig(config, childTaskId)?.taskExecutionId).toBe("wst_valid_timestamp");
    expect(findWorkspaceInConfig(config, childTaskId)?.taskExecutionStatus).toBe("running");
  });

  test("initialize contains per-child reconciliation persistence failures", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    const childTaskId = "child-reconciliation-write-failure";
    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath);
      assert(project, "test project must exist");
      project.workspaces.push(
        projectWorkspace(projectPath, "child-write-failure", childTaskId, {
          parentWorkspaceId: parentId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "reported",
        })
      );
      return cfg;
    });
    const isStreaming = mock((workspaceId: string) => workspaceId === childTaskId);
    const { aiService } = createAIServiceMocks(config, { isStreaming });
    const { taskService } = createTaskServiceHarness(config, { aiService });
    const taskHandleStore = new TaskHandleStore(config);
    await taskHandleStore.upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, childTaskId, "wst_write_failure", "running", {
        turnId: "turn-write-failure",
        createdAt: "2026-08-10T00:00:00.000Z",
        updatedAt: "2026-08-10T00:00:01.000Z",
      })
    );
    const internal = taskService as unknown as {
      emitWorkspaceMetadata: (workspaceId: string) => Promise<void>;
    };
    spyOn(internal, "emitWorkspaceMetadata").mockImplementation((workspaceId: string) =>
      workspaceId === childTaskId
        ? Promise.reject(new Error("read-only session"))
        : Promise.resolve()
    );

    let initializationError: unknown;
    try {
      await taskService.initialize();
    } catch (error: unknown) {
      initializationError = error;
    }

    expect(initializationError).toBeUndefined();
    expect(findWorkspaceInConfig(config, childTaskId)?.taskExecutionId).toBe("wst_write_failure");
  });

  test("resolves a nested child execution through the ancestor that owns its handle", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-execution-owner";
    const parentTaskId = "parent-execution-owner";
    const childTaskId = "child-execution-owner";
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId),
        projectWorkspace(projectPath, "parent", parentTaskId, {
          parentWorkspaceId: rootWorkspaceId,
          taskStatus: "reported",
        }),
        projectWorkspace(projectPath, "child", childTaskId, {
          parentWorkspaceId: parentTaskId,
          taskStatus: "reported",
          taskExecutionId: "wst_nested_execution",
          taskExecutionStatus: "running",
        }),
      ],
      testTaskSettings()
    );
    const isStreaming = mock((workspaceId: string) => workspaceId === childTaskId);
    const { aiService } = createAIServiceMocks(config, { isStreaming });
    const { taskService } = createTaskServiceHarness(config, { aiService });
    const taskHandleStore = new TaskHandleStore(config);
    await taskHandleStore.upsertWorkspaceTurn(
      workspaceTurnRecord(parentTaskId, childTaskId, "wst_nested_execution", "running", {
        turnId: "turn-nested-execution",
        createdAt: "2026-08-10T00:00:00.000Z",
        updatedAt: "2026-08-10T00:00:01.000Z",
      })
    );

    const execution = await taskService.getDescendantAgentTaskExecutionSnapshot(
      rootWorkspaceId,
      childTaskId
    );

    expect(execution?.ownerWorkspaceId).toBe(parentTaskId);
    expect(execution?.record).toMatchObject({
      handleId: "wst_nested_execution",
      workspaceId: childTaskId,
      status: "running",
    });
  });

  test("initialize recovers terminal notify workspace turns without pending notification", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const handleId = "wst_restart_missing_notification";
    await new TaskHandleStore(config).upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, "childworkspace", handleId, "completed", {
        attentionPolicy: "notify_on_terminal",
        reportMarkdown: "Done before notification persisted",
      })
    );

    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    await taskService.initialize();
    await flushTerminalAttentionDrains(taskService);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(String(sendMessage.mock.calls[0]?.[1])).toContain(handleId);
    const snapshot = await workspaceTurnSnapshot(taskService, parentId, handleId);
    expect(snapshot?.terminalAttentionNotifiedAt).toBeDefined();
  });

  test("initialize defers terminal wake-up while blocking task-owned work is active", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);

    const terminalAttentionStore = new TerminalAttentionStore(config);
    await terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: parentId,
      sourceKind: "agent_task",
      sourceId: "task_done",
    });

    await new TaskHandleStore(config).upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, "childworkspace", "wst_blocking_active", "running", {
        updatedAt: "2026-06-19T00:00:00.000Z",
        createdWorkspace: true,
      })
    );

    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    workspaceTurnManagerInternals(taskService).activeWorkspaceTurnHandleByWorkspaceId.set(
      "childworkspace",
      {
        handleId: "wst_blocking_active",
        ownerWorkspaceId: parentId,
        accepted: false,
      }
    );

    await taskService.initialize();
    await flushTerminalAttentionDrains(taskService);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(await terminalAttentionStore.listPending(parentId)).toHaveLength(1);
  });

  test("workspace-turn stream-end with non-stop finish marks the handle error", async () => {
    const { parentId, taskService } = await startWorkspaceTurnForTest(rootDir);

    await streamEnd(
      taskService,
      workspaceTurnStreamEndEvent(parentId, "msg_truncated", "Partial", { finishReason: "length" })
    );

    const snapshot = await workspaceTurnSnapshot(taskService, parentId);
    expect(snapshot).toMatchObject({
      status: "error",
      workspaceId: "childworkspace",
      messageId: "msg_truncated",
      error: "Workspace turn ended before completion (finishReason: length)",
    });
    expect(snapshot?.reportMarkdown).toBeUndefined();
  });

  test("workspace-turn tool-calls stream-end defers to a queued wake continuation", async () => {
    // A queued bash-monitor wake cuts the correlated stream at a tool boundary
    // (finishReason "tool-calls") while the child seamlessly continues the
    // same turn — the handle must stay running.
    const hasPendingBashMonitorWakeContinuation = mock(
      (workspaceId: string) => workspaceId === "childworkspace"
    );
    const { parentId, taskService } = await startWorkspaceTurnForTest(rootDir, {
      hasPendingBashMonitorWakeContinuation,
    });
    const correlation = workspaceTurnMuxMetadata(parentId);

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_queue_cut",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "tool-calls",
        muxMetadata: correlation,
      },
      parts: [{ type: "text", text: "Kicked off verification" }],
    });

    const running = await workspaceTurnSnapshot(taskService, parentId);
    expect(running).toMatchObject({ status: "running", workspaceId: "childworkspace" });
    expect(running?.error).toBeUndefined();

    // The continuation stream inherits the correlation metadata (see
    // AgentSession.inheritOpenWorkspaceTurnMetadata); its terminal stream-end
    // settles the turn with the real outcome.
    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_continuation_final",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata: correlation,
      },
      parts: [{ type: "text", text: "Final review report" }],
    });

    const settled = await workspaceTurnSnapshot(taskService, parentId);
    expect(settled).toMatchObject({
      status: "completed",
      messageId: "msg_continuation_final",
      reportMarkdown: "Final review report",
    });
  });

  test("nested agent progress preserves workspace-turn correlation", async () => {
    const hasPendingWorkspaceTurnContinuation = mock(
      (
        workspaceId: string,
        metadata: { taskHandleId: string; ownerWorkspaceId: string; turnId: string }
      ) =>
        workspaceId === "childworkspace" &&
        metadata.taskHandleId === "wst_handle" &&
        metadata.turnId === "turn"
    );
    const { config, parentId, taskService, workspaceMocks } = await startWorkspaceTurnForTest(
      rootDir,
      {
        hasPendingWorkspaceTurnContinuation,
      }
    );
    const correlation = workspaceTurnMuxMetadata(parentId);

    await config.editConfig((cfg) => {
      const project = cfg.projects.get(path.join(rootDir, "repo"));
      assert(project, "test project must exist");
      project.workspaces.push({
        path: path.join(rootDir, "repo", "nested-agent"),
        id: "nested-agent",
        name: "nested-agent",
        createdAt: "2026-06-19T00:00:00.000Z",
        runtimeConfig: { type: "local" },
        parentWorkspaceId: "childworkspace",
        taskStatus: "running",
        agentType: "explore",
        taskModelString: "anthropic:claude-opus-4-6",
      });
      return cfg;
    });

    await taskService.reportAgentProgress("nested-agent", "progress-call", {
      reportMarkdown: "The nested agent found the issue.",
    });
    expect(workspaceMocks.sendMessage).toHaveBeenCalledTimes(2);
    expect(workspaceMocks.sendMessage.mock.calls[1]?.[2]).toMatchObject({
      muxMetadata: correlation,
    });

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_nested_report_cut",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "tool-calls",
        muxMetadata: correlation,
      },
      parts: [{ type: "text", text: "Nested report interrupted the turn" }],
    });

    expect(await workspaceTurnSnapshot(taskService, parentId)).toMatchObject({
      status: "running",
    });

    await config.editConfig((cfg) => {
      const project = cfg.projects.get(path.join(rootDir, "repo"));
      assert(project, "test project must exist");
      const nestedAgent = project.workspaces.find((workspace) => workspace.id === "nested-agent");
      assert(nestedAgent, "nested agent must exist");
      nestedAgent.taskStatus = "reported";
      nestedAgent.reportedAt = "2026-06-19T00:00:01.000Z";
      return cfg;
    });

    hasPendingWorkspaceTurnContinuation.mockReturnValue(false);
    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_nested_report_final",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata: correlation,
      },
      parts: [{ type: "text", text: "Nested report continuation completed" }],
    });

    expect(await workspaceTurnSnapshot(taskService, parentId)).toMatchObject({
      status: "completed",
      reportMarkdown: "Nested report continuation completed",
    });
  });

  test("failed nested agent progress settles the correlated workspace turn", async () => {
    let sendCount = 0;
    const sendMessage = mock(
      async (...args: unknown[]): Promise<Result<void, SendMessageError>> => {
        sendCount += 1;
        if (sendCount === 2) {
          const internal = args[3] as
            | { onAcceptedPreStreamFailure?: (error: SendMessageError) => Promise<void> | void }
            | undefined;
          await internal?.onAcceptedPreStreamFailure?.({
            type: "unknown",
            raw: "Progress wake failed",
          });
        }
        return Ok(undefined);
      }
    );
    const { config, parentId, taskService } = await startWorkspaceTurnForTest(rootDir, {
      sendMessage,
    });

    await config.editConfig((cfg) => {
      const project = cfg.projects.get(path.join(rootDir, "repo"));
      assert(project, "test project must exist");
      project.workspaces.push({
        path: path.join(rootDir, "repo", "nested-progress-failure"),
        id: "nested-progress-failure",
        name: "nested-progress-failure",
        createdAt: "2026-06-19T00:00:00.000Z",
        runtimeConfig: { type: "local" },
        parentWorkspaceId: "childworkspace",
        taskStatus: "running",
        agentType: "explore",
      });
      return cfg;
    });

    await taskService.reportAgentProgress("nested-progress-failure", "progress-call", {
      reportMarkdown: "The progress wake cannot start.",
    });

    expect(await workspaceTurnSnapshot(taskService, parentId)).toMatchObject({
      status: "error",
      error: "Progress wake failed",
    });
  });

  test("canceled nested agent progress interrupts the correlated workspace turn", async () => {
    let sendCount = 0;
    const sendMessage = mock(
      async (...args: unknown[]): Promise<Result<void, SendMessageError>> => {
        sendCount += 1;
        if (sendCount === 2) {
          const internal = args[3] as
            | { onCanceled?: (reason: string) => Promise<void> | void }
            | undefined;
          await internal?.onCanceled?.("Progress wake was canceled");
        }
        return Ok(undefined);
      }
    );
    const { config, parentId, taskService } = await startWorkspaceTurnForTest(rootDir, {
      sendMessage,
    });

    await config.editConfig((cfg) => {
      const project = cfg.projects.get(path.join(rootDir, "repo"));
      assert(project, "test project must exist");
      project.workspaces.push({
        path: path.join(rootDir, "repo", "nested-progress-canceled"),
        id: "nested-progress-canceled",
        name: "nested-progress-canceled",
        createdAt: "2026-06-19T00:00:00.000Z",
        runtimeConfig: { type: "local" },
        parentWorkspaceId: "childworkspace",
        taskStatus: "running",
        agentType: "explore",
      });
      return cfg;
    });

    await taskService.reportAgentProgress("nested-progress-canceled", "progress-call", {
      reportMarkdown: "The progress wake was canceled.",
    });

    expect(await workspaceTurnSnapshot(taskService, parentId)).toMatchObject({
      status: "interrupted",
      error: "Progress wake was canceled",
    });
  });

  test("superseded nested agent progress is refused without settling the correlated workspace turn", async () => {
    let progressInternal:
      | {
          admissionStale?: () => boolean;
          onCanceled?: (reason: string) => Promise<void> | void;
          onAcceptedPreStreamFailure?: (error: SendMessageError) => Promise<void> | void;
        }
      | undefined;
    let sendCount = 0;
    const sendMessage = mock((...args: unknown[]): Promise<Result<void, SendMessageError>> => {
      sendCount += 1;
      if (sendCount === 2) {
        // Queued behind the busy parent: the session re-checks the probe at dispatch.
        progressInternal = args[3] as typeof progressInternal;
      }
      return Promise.resolve(Ok(undefined));
    });
    const { config, parentId, taskService } = await startWorkspaceTurnForTest(rootDir, {
      sendMessage,
    });

    await config.editConfig((cfg) => {
      const project = cfg.projects.get(path.join(rootDir, "repo"));
      assert(project, "test project must exist");
      project.workspaces.push({
        path: path.join(rootDir, "repo", "nested-progress-superseded"),
        id: "nested-progress-superseded",
        name: "nested-progress-superseded",
        createdAt: "2026-06-19T00:00:00.000Z",
        runtimeConfig: { type: "local" },
        parentWorkspaceId: "childworkspace",
        taskStatus: "running",
        agentType: "explore",
      });
      return cfg;
    });

    await taskService.reportAgentProgress("nested-progress-superseded", "progress-call", {
      reportMarkdown: "Partial findings.",
    });
    assert(progressInternal?.admissionStale, "progress sends must carry a supersession probe");
    expect(progressInternal.admissionStale()).toBe(false);

    // The grandchild's terminal report lands (handleAgentReport persists `reported` first).
    await config.editConfig((cfg) => {
      const project = cfg.projects.get(path.join(rootDir, "repo"));
      assert(project, "test project must exist");
      const nested = project.workspaces.find(
        (workspace) => workspace.id === "nested-progress-superseded"
      );
      assert(nested, "nested agent must exist");
      nested.taskStatus = "reported";
      nested.reportedAt = "2026-06-19T00:00:01.000Z";
      return cfg;
    });
    expect(progressInternal.admissionStale()).toBe(true);

    // The session refuses the stale entry through these hooks; the parent's live delegated turn
    // must survive because the terminal delivery is its next wake.
    await progressInternal.onCanceled?.("Send refused: the caller's admission became stale");
    await progressInternal.onAcceptedPreStreamFailure?.({ type: "unknown", raw: "stale" });
    expect(await workspaceTurnSnapshot(taskService, parentId)).toMatchObject({
      status: "running",
    });
  });

  test("workspace-turn tool-calls stream-end with superseding queued input settles interrupted", async () => {
    // Ordinary queued input (manual message, bare /compact) also cuts the
    // stream at a tool boundary, but it supersedes the delegated turn instead
    // of continuing it — the handle must settle now, not defer forever. The
    // child keeps working under the new input, so the owner sees an
    // interruption with a supersede reason, not a task failure.
    const hasPendingQueuedOrPreparingTurn = mock(
      (workspaceId: string) => workspaceId === "childworkspace"
    );
    const { parentId, taskService } = await startWorkspaceTurnForTest(rootDir, {
      hasPendingQueuedOrPreparingTurn,
    });

    await streamEnd(
      taskService,
      workspaceTurnStreamEndEvent(parentId, "msg_superseded_cut", "Cut mid-work", {
        finishReason: "tool-calls",
      })
    );

    const snapshot = await workspaceTurnSnapshot(taskService, parentId);
    expect(snapshot).toMatchObject({
      status: "interrupted",
      messageId: "msg_superseded_cut",
      error:
        "Workspace turn superseded by new input in the target workspace; the workspace continues under that input and this delegated turn will not report",
    });
  });

  const OWNER_FOLLOW_UP_SUPERSEDE_PREFIX = "Workspace turn superseded by follow-up turn ";

  function ownerFollowUpCutter(ownerWorkspaceId: string, successorHandleId: string) {
    return {
      stage: "queued" as const,
      dispatchMode: "tool-end" as const,
      muxMetadata: workspaceTurnMuxMetadata(ownerWorkspaceId, successorHandleId, "turn2"),
    };
  }

  function ownerFollowUpCutEvent(parentId: string, messageId: string): StreamEndEvent {
    return {
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId,
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "tool-calls",
        muxMetadata: workspaceTurnMuxMetadata(parentId),
      },
      parts: [{ type: "text", text: "Cut mid-work" }],
    };
  }

  test("workspace-turn cut by the owner's own tool-end follow-up settles quietly", async () => {
    // The owner initiated the successor itself (mode="existing" tool-end
    // follow-up), so the old handle settles interrupted with a reason naming
    // the successor and produces NO terminal-attention wake — the follow-up's
    // task tool result already announced this outcome.
    const { config, parentId, taskService, workspaceMocks } =
      await startWorkspaceTurnForTest(rootDir);
    const taskHandleStore = new TaskHandleStore(config);
    const running = await taskHandleStore.getWorkspaceTurn(parentId, "wst_handle");
    assert(running, "running handle must exist");
    await taskHandleStore.upsertWorkspaceTurn({
      ...running,
      attentionPolicy: "notify_on_terminal",
    });
    workspaceMocks.getQueueCutCutter.mockImplementation((workspaceId: string) =>
      workspaceId === "childworkspace" ? ownerFollowUpCutter(parentId, "wst_successor") : undefined
    );

    await streamEnd(taskService, ownerFollowUpCutEvent(parentId, "msg_owner_follow_up_cut"));

    const settled = await taskHandleStore.getWorkspaceTurn(parentId, "wst_handle");
    assert(settled, "settled handle must exist");
    expect(settled).toMatchObject({
      status: "interrupted",
      messageId: "msg_owner_follow_up_cut",
    });
    expect(settled.error?.startsWith(OWNER_FOLLOW_UP_SUPERSEDE_PREFIX)).toBe(true);
    expect(settled.error).toContain("wst_successor");
    // Quiet: no wake enqueued, no parent envelope required. The notified
    // marker IS stamped as the downgrade-compatible suppression marker so an
    // older build's startup recovery also skips this record.
    expect(settled.terminalAttentionNotifiedAt).toBeDefined();
    expect(settled.directParentResultDeliveryRequiredAt).toBeUndefined();
    const attentionStore = new TerminalAttentionStore(config);
    expect(
      await attentionStore.get(
        parentId,
        TerminalAttentionStore.notificationId("workspace_turn", "wst_handle")
      )
    ).toBeNull();
    expect(
      await attentionStore.get(
        parentId,
        TerminalAttentionStore.notificationId(
          "workspace_turn",
          "wst_handle",
          `wst_handle:interrupted:${settled.updatedAt}`
        )
      )
    ).toBeNull();
  });

  test("workspace-turn cut by a different owner's follow-up keeps the generic supersede wake", async () => {
    // Cross-owner ancestor cutter (allowAgentWorkspace descendant path): the
    // settling handle's owner did not cause the cut, so it must still be woken.
    const { config, parentId, taskService, workspaceMocks } =
      await startWorkspaceTurnForTest(rootDir);
    const taskHandleStore = new TaskHandleStore(config);
    const running = await taskHandleStore.getWorkspaceTurn(parentId, "wst_handle");
    assert(running, "running handle must exist");
    await taskHandleStore.upsertWorkspaceTurn({
      ...running,
      attentionPolicy: "notify_on_terminal",
    });
    workspaceMocks.getQueueCutCutter.mockImplementation(() =>
      ownerFollowUpCutter("ancestorownerws", "wst_ancestor_follow_up")
    );

    await streamEnd(taskService, ownerFollowUpCutEvent(parentId, "msg_cross_owner_cut"));

    const settled = await taskHandleStore.getWorkspaceTurn(parentId, "wst_handle");
    assert(settled, "settled handle must exist");
    expect(settled).toMatchObject({
      status: "interrupted",
      error:
        "Workspace turn superseded by new input in the target workspace; the workspace continues under that input and this delegated turn will not report",
    });
    expect(settled.terminalAttentionNotifiedAt).toBeDefined();
    expect(
      await new TerminalAttentionStore(config).get(
        parentId,
        TerminalAttentionStore.notificationId(
          "workspace_turn",
          "wst_handle",
          `wst_handle:interrupted:${settled.updatedAt}`
        )
      )
    ).not.toBeNull();
  });

  test("same-owner follow-up queued at turn-end keeps the generic supersede reason", async () => {
    // A turn-end head did not cause a tool-boundary cut, so it must not claim
    // quiet owner-follow-up attribution.
    const { config, parentId, taskService, workspaceMocks } =
      await startWorkspaceTurnForTest(rootDir);
    workspaceMocks.getQueueCutCutter.mockImplementation(() => ({
      ...ownerFollowUpCutter(parentId, "wst_successor"),
      dispatchMode: "turn-end" as const,
    }));

    await streamEnd(taskService, ownerFollowUpCutEvent(parentId, "msg_turn_end_cut"));

    expect(
      await new TaskHandleStore(config).getWorkspaceTurn(parentId, "wst_handle")
    ).toMatchObject({
      status: "interrupted",
      error:
        "Workspace turn superseded by new input in the target workspace; the workspace continues under that input and this delegated turn will not report",
    });
  });

  test("an engaged no-metadata cutter is never attributed to a follow-up queued behind it", async () => {
    // A manual message in PREPARING is the engaged cutter even when a
    // same-owner follow-up sits queued behind it: the cutter reports stage
    // "preparing" with undefined metadata, which classifies generic (notify).
    const { config, parentId, taskService, workspaceMocks } =
      await startWorkspaceTurnForTest(rootDir);
    workspaceMocks.getQueueCutCutter.mockImplementation(() => ({
      stage: "preparing" as const,
      muxMetadata: undefined,
    }));

    await streamEnd(taskService, ownerFollowUpCutEvent(parentId, "msg_engaged_manual_cut"));

    expect(
      await new TaskHandleStore(config).getWorkspaceTurn(parentId, "wst_handle")
    ).toMatchObject({
      status: "interrupted",
      error:
        "Workspace turn superseded by new input in the target workspace; the workspace continues under that input and this delegated turn will not report",
    });
  });

  test("an already-streaming same-owner follow-up settles the cut handle quietly", async () => {
    // The queue drained before this stream-end was processed: the successor is
    // identified from the uncorrelated active stream's metadata instead.
    const { config, parentId, taskService, aiMocks } = await startWorkspaceTurnForTest(rootDir);
    aiMocks.getStreamInfo.mockImplementation((workspaceId: string) =>
      workspaceId === "childworkspace"
        ? {
            messageId: "msg_successor_stream",
            model: "anthropic:claude-opus-4-6",
            historySequence: 3,
            startTime: Date.now(),
            parts: [],
            toolCompletionTimestamps: new Map(),
            muxMetadata: workspaceTurnMuxMetadata(parentId, "wst_successor", "turn2"),
          }
        : undefined
    );

    await streamEnd(taskService, ownerFollowUpCutEvent(parentId, "msg_streaming_successor_cut"));

    const settled = await new TaskHandleStore(config).getWorkspaceTurn(parentId, "wst_handle");
    expect(settled).toMatchObject({ status: "interrupted" });
    expect(settled?.error?.startsWith(OWNER_FOLLOW_UP_SUPERSEDE_PREFIX)).toBe(true);
    expect(settled?.error).toContain("wst_successor");
  });

  test("foreground waiters on a quietly superseded handle reject with the successor id", async () => {
    const { parentId, taskService, workspaceMocks } = await startWorkspaceTurnForTest(rootDir);
    workspaceMocks.getQueueCutCutter.mockImplementation(() =>
      ownerFollowUpCutter(parentId, "wst_successor")
    );
    const waited = workspaceTurnManagerFor(taskService)
      .waitForWorkspaceTurn("wst_handle", {
        requestingWorkspaceId: parentId,
        timeoutMs: 5_000,
      })
      .then(
        () => null,
        (error: unknown) => error
      );

    await streamEnd(taskService, ownerFollowUpCutEvent(parentId, "msg_waiter_cut"));

    const error = await waited;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("wst_successor");
  });

  test("late foreground waiters read the persisted quiet supersede reason", async () => {
    // Codex P2: a waiter whose initial record read completes after the quiet
    // settlement misses the live waiter path; the terminal `interrupted`
    // branch must preserve the persisted reason (and its successor handle id)
    // instead of a generic message.
    const { parentId, taskService, workspaceMocks } = await startWorkspaceTurnForTest(rootDir);
    workspaceMocks.getQueueCutCutter.mockImplementation(() =>
      ownerFollowUpCutter(parentId, "wst_successor")
    );
    await streamEnd(taskService, ownerFollowUpCutEvent(parentId, "msg_late_waiter_cut"));

    let error: unknown;
    try {
      await workspaceTurnManagerFor(taskService).waitForWorkspaceTurn("wst_handle", {
        requestingWorkspaceId: parentId,
        timeoutMs: 5_000,
      });
      expect.unreachable("late waiter must reject");
    } catch (caught) {
      error = caught;
    }
    assert(error instanceof Error, "late waiter must reject with an Error");
    expect(error.message.startsWith(OWNER_FOLLOW_UP_SUPERSEDE_PREFIX)).toBe(true);
    expect(error.message).toContain("wst_successor");
  });

  test("cancelled successor forwards disposable ownership to the next queued follow-up", async () => {
    // Codex P1 (three-handle chain): A transferred ownership to B; B is then
    // cancelled through the non-stream settlement path while C is still
    // queued. Cleanup must forward ownership to C instead of deleting the
    // workspace under it, and only the last handle in the chain removes it.
    const remove = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const { config, parentId, taskService, workspaceMocks } = await startWorkspaceTurnForTest(
      rootDir,
      {
        disposable: true,
        remove,
      }
    );
    const taskHandleStore = new TaskHandleStore(config);
    const queuedBase = {
      kind: "workspace_turn" as const,
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      status: "queued" as const,
      createdWorkspace: false,
      disposableWorkspace: false,
    };
    await taskHandleStore.upsertWorkspaceTurn({
      ...queuedBase,
      handleId: "wst_successor",
      turnId: "turn2",
      createdAt: "2026-08-11T00:00:01.000Z",
      updatedAt: "2026-08-11T00:00:01.000Z",
    });
    await taskHandleStore.upsertWorkspaceTurn({
      ...queuedBase,
      handleId: "wst_successor2",
      turnId: "turn3",
      createdAt: "2026-08-11T00:00:02.000Z",
      updatedAt: "2026-08-11T00:00:02.000Z",
    });
    workspaceMocks.getQueueCutCutter.mockImplementation(() =>
      ownerFollowUpCutter(parentId, "wst_successor")
    );
    await streamEnd(taskService, ownerFollowUpCutEvent(parentId, "msg_chain_cut"));
    expect(
      (await taskHandleStore.getWorkspaceTurn(parentId, "wst_successor"))?.disposableWorkspace
    ).toBe(true);

    const stopped = await workspaceTurnManagerFor(taskService).interruptWorkspaceTurn(
      parentId,
      "wst_successor"
    );
    expect(stopped.success).toBe(true);
    expect(await taskHandleStore.getWorkspaceTurn(parentId, "wst_successor")).toMatchObject({
      status: "interrupted",
      disposableWorkspace: false,
    });
    expect(
      (await taskHandleStore.getWorkspaceTurn(parentId, "wst_successor2"))?.disposableWorkspace
    ).toBe(true);
    expect(remove).not.toHaveBeenCalled();

    // The last handle in the chain has no live successor left: remove for real.
    const stoppedLast = await workspaceTurnManagerFor(taskService).interruptWorkspaceTurn(
      parentId,
      "wst_successor2"
    );
    expect(stoppedLast.success).toBe(true);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  test("late correlated completion self-heals a quiet supersede and re-arms the corrected wake", async () => {
    const { config, parentId, taskService, workspaceMocks } =
      await startWorkspaceTurnForTest(rootDir);
    const taskHandleStore = new TaskHandleStore(config);
    const running = await taskHandleStore.getWorkspaceTurn(parentId, "wst_handle");
    assert(running, "running handle must exist");
    await taskHandleStore.upsertWorkspaceTurn({
      ...running,
      attentionPolicy: "notify_on_terminal",
    });
    workspaceMocks.getQueueCutCutter.mockImplementation(() =>
      ownerFollowUpCutter(parentId, "wst_successor")
    );
    await streamEnd(taskService, ownerFollowUpCutEvent(parentId, "msg_owner_follow_up_cut"));
    expect(await taskHandleStore.getWorkspaceTurn(parentId, "wst_handle")).toMatchObject({
      status: "interrupted",
    });
    workspaceMocks.getQueueCutCutter.mockImplementation(() => undefined);

    // Late correlated evidence proves the turn actually completed: the quiet
    // supersede stays self-heal eligible and the corrected outcome re-arms the
    // (non-suppressed) wake.
    await streamEnd(
      taskService,
      workspaceTurnStreamEndEvent(parentId, "msg_late_final", "Late done")
    );

    const healed = await taskHandleStore.getWorkspaceTurn(parentId, "wst_handle");
    assert(healed, "healed handle must exist");
    expect(healed).toMatchObject({ status: "completed", reportMarkdown: "Late done" });
    expect(
      await new TerminalAttentionStore(config).get(
        parentId,
        TerminalAttentionStore.notificationId(
          "workspace_turn",
          "wst_handle",
          `wst_handle:completed:${healed.updatedAt}`
        )
      )
    ).not.toBeNull();
  });

  test("task_stop on a quietly superseded handle stays a no-op", async () => {
    // The widened supersede matcher must not change the interrupt gate: the
    // handle is already interrupted, so a stale task_stop must not stop the
    // target workspace's successor stream.
    const { parentId, taskService, workspaceMocks, aiMocks } =
      await startWorkspaceTurnForTest(rootDir);
    workspaceMocks.getQueueCutCutter.mockImplementation(() =>
      ownerFollowUpCutter(parentId, "wst_successor")
    );
    await streamEnd(taskService, ownerFollowUpCutEvent(parentId, "msg_stop_noop_cut"));
    aiMocks.stopStream.mockClear();

    const repeat = await workspaceTurnManagerFor(taskService).interruptWorkspaceTurn(
      parentId,
      "wst_handle"
    );
    expect(repeat).toEqual(Ok({ workspaceId: "childworkspace" }));
    expect(aiMocks.stopStream).not.toHaveBeenCalled();
  });

  test("cut attribution is captured at event time, before the workspace event lock", async () => {
    // Race pin (Codex P1): a manual/cross-owner input cuts the turn, then a
    // same-owner follow-up engages while handleStreamEnd's awaits run.
    // Classification must use the attribution snapshot captured synchronously
    // at the stream-end event (the manual cutter) — not whatever is engaged by
    // classification time — so the real manual supersede keeps its wake.
    let cutterReads = 0;
    const getQueueCutCutter = mock(() => {
      cutterReads += 1;
      return cutterReads === 1
        ? { stage: "preparing" as const, muxMetadata: undefined }
        : ownerFollowUpCutter("will-be-set-below", "wst_successor");
    });
    const { config, parentId, taskService } = await startWorkspaceTurnForTest(rootDir, {
      getQueueCutCutter,
    });
    getQueueCutCutter.mockImplementation(() => {
      cutterReads += 1;
      return cutterReads === 1
        ? { stage: "preparing" as const, muxMetadata: undefined }
        : ownerFollowUpCutter(parentId, "wst_successor");
    });

    await streamEnd(taskService, ownerFollowUpCutEvent(parentId, "msg_snapshot_race_cut"));

    expect(cutterReads).toBeGreaterThanOrEqual(1);
    expect(
      await new TaskHandleStore(config).getWorkspaceTurn(parentId, "wst_handle")
    ).toMatchObject({
      status: "interrupted",
      error:
        "Workspace turn superseded by new input in the target workspace; the workspace continues under that input and this delegated turn will not report",
    });
  });

  test("quiet supersede transfers disposable ownership to the successor", async () => {
    // Codex P1: settling the old handle must not force-remove a disposable
    // workspace out from under the announced successor. Ownership moves to the
    // successor handle, whose own terminal settlement cleans the workspace up.
    const remove = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const { config, parentId, taskService, workspaceMocks } = await startWorkspaceTurnForTest(
      rootDir,
      {
        disposable: true,
        remove,
      }
    );
    const taskHandleStore = new TaskHandleStore(config);
    await taskHandleStore.upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, "childworkspace", "wst_successor", "queued", {
        turnId: "turn2",
        createdAt: "2026-08-11T00:00:00.000Z",
        updatedAt: "2026-08-11T00:00:00.000Z",
      })
    );
    workspaceMocks.getQueueCutCutter.mockImplementation(() =>
      ownerFollowUpCutter(parentId, "wst_successor")
    );

    await streamEnd(taskService, ownerFollowUpCutEvent(parentId, "msg_disposable_transfer"));

    const settled = await taskHandleStore.getWorkspaceTurn(parentId, "wst_handle");
    expect(settled).toMatchObject({ status: "interrupted", disposableWorkspace: false });
    expect(settled?.error?.startsWith(OWNER_FOLLOW_UP_SUPERSEDE_PREFIX)).toBe(true);
    expect(
      (await taskHandleStore.getWorkspaceTurn(parentId, "wst_successor"))?.disposableWorkspace
    ).toBe(true);
    expect(remove).not.toHaveBeenCalled();
  });

  test("quiet supersede keeps disposable cleanup when the successor is unavailable", async () => {
    // Transfer fail-safe: a missing (or already terminal) successor record
    // cannot inherit cleanup responsibility, so the old handle keeps it and
    // the disposable workspace is not leaked.
    const remove = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const { config, parentId, taskService, workspaceMocks } = await startWorkspaceTurnForTest(
      rootDir,
      {
        disposable: true,
        remove,
      }
    );
    workspaceMocks.getQueueCutCutter.mockImplementation(() =>
      ownerFollowUpCutter(parentId, "wst_missing_successor")
    );

    await streamEnd(taskService, ownerFollowUpCutEvent(parentId, "msg_disposable_no_successor"));

    expect(
      await new TaskHandleStore(config).getWorkspaceTurn(parentId, "wst_handle")
    ).toMatchObject({
      status: "interrupted",
      disposableWorkspace: true,
    });
    expect(remove).toHaveBeenCalledTimes(1);
  });

  test("quiet resettle deletes the stale wake enqueued by the superseded settlement", async () => {
    // Codex P2: an error settlement enqueued a pending wake; a later
    // correlated tool-calls resettle to the quiet owner-follow-up flavor must
    // delete that stale generation instead of letting the drain deliver it.
    const { config, parentId, taskService, workspaceMocks } =
      await startWorkspaceTurnForTest(rootDir);
    const taskHandleStore = new TaskHandleStore(config);
    const running = await taskHandleStore.getWorkspaceTurn(parentId, "wst_handle");
    assert(running, "running handle must exist");
    await taskHandleStore.upsertWorkspaceTurn({
      ...running,
      attentionPolicy: "notify_on_terminal",
    });

    // Length-truncated correlated final settles the handle as error and arms a wake.
    const truncated = workspaceTurnStreamEndEvent(parentId, "msg_truncated_error", "Truncated", {
      finishReason: "length",
    });
    truncated.metadata.historySequence = 1;
    await streamEnd(taskService, truncated);
    const errored = await taskHandleStore.getWorkspaceTurn(parentId, "wst_handle");
    assert(errored, "errored handle must exist");
    expect(errored.status).toBe("error");
    const attentionStore = new TerminalAttentionStore(config);
    const staleVersionedId = TerminalAttentionStore.notificationId(
      "workspace_turn",
      "wst_handle",
      `wst_handle:error:${errored.updatedAt}`
    );
    expect(await attentionStore.get(parentId, staleVersionedId)).not.toBeNull();

    // Same-turn auto-retry gets cut by the owner's follow-up: quiet resettle.
    workspaceMocks.getQueueCutCutter.mockImplementation(() =>
      ownerFollowUpCutter(parentId, "wst_successor")
    );
    const cut = ownerFollowUpCutEvent(parentId, "msg_quiet_resettle_cut");
    cut.metadata.historySequence = 2;
    await streamEnd(taskService, cut);

    const resettled = await taskHandleStore.getWorkspaceTurn(parentId, "wst_handle");
    assert(resettled, "resettled handle must exist");
    expect(resettled.status).toBe("interrupted");
    expect(resettled.error?.startsWith(OWNER_FOLLOW_UP_SUPERSEDE_PREFIX)).toBe(true);
    // Stale delivered marker cleared by the resettle, then re-stamped as the
    // quiet flavor's downgrade-compatible suppression marker.
    expect(resettled.terminalAttentionNotifiedAt).toBeDefined();
    expect(await attentionStore.get(parentId, staleVersionedId)).toBeNull();
    expect(
      await attentionStore.get(
        parentId,
        TerminalAttentionStore.notificationId("workspace_turn", "wst_handle")
      )
    ).toBeNull();
    expect(
      await attentionStore.get(
        parentId,
        TerminalAttentionStore.notificationId(
          "workspace_turn",
          "wst_handle",
          `wst_handle:interrupted:${resettled.updatedAt}`
        )
      )
    ).toBeNull();
  });

  test("drain drops a stale wake whose handle has settled into the quiet flavor", async () => {
    // Codex P2: a drain's listPending() snapshot can predate a quiet
    // resettle's notification delete, so the files alone cannot retract the
    // wake. The handle record re-read inside the drain is the source of
    // truth: a suppressed handle must be dropped, not delivered.
    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    const hasPendingQueuedOrPreparingTurn = mock(
      (workspaceId: string): boolean => workspaceId === "owner"
    );
    const { config, parentId, taskService } = await startWorkspaceTurnForTest(rootDir, {
      sendMessage,
      hasPendingQueuedOrPreparingTurn,
    });
    // Keep the owner busy while the error settlement arms the wake so it stays pending.
    hasPendingQueuedOrPreparingTurn.mockImplementation(
      (workspaceId: string) => workspaceId === parentId
    );
    const taskHandleStore = new TaskHandleStore(config);
    const running = await taskHandleStore.getWorkspaceTurn(parentId, "wst_handle");
    assert(running, "running handle must exist");
    await taskHandleStore.upsertWorkspaceTurn({
      ...running,
      attentionPolicy: "notify_on_terminal",
    });
    const internal = taskService as unknown as {
      pendingTerminalAttentionDrains: Set<Promise<void>>;
      drainTerminalAttention: (ownerWorkspaceId: string) => Promise<void>;
    };
    await streamEnd(
      taskService,
      workspaceTurnStreamEndEvent(parentId, "msg_truncated_before_quiet", "Truncated", {
        finishReason: "length",
      })
    );
    await Promise.all([...internal.pendingTerminalAttentionDrains]);
    const errored = await taskHandleStore.getWorkspaceTurn(parentId, "wst_handle");
    assert(errored, "errored handle must exist");
    const attentionStore = new TerminalAttentionStore(config);
    const staleVersionedId = TerminalAttentionStore.notificationId(
      "workspace_turn",
      "wst_handle",
      `wst_handle:error:${errored.updatedAt}`
    );
    expect(await attentionStore.get(parentId, staleVersionedId)).toMatchObject({
      status: "pending",
    });

    // The quiet flavor lands on the record while the pending files survive
    // (drain snapshot semantics): the drain must drop the wake anyway.
    await taskHandleStore.upsertWorkspaceTurn({
      ...errored,
      status: "interrupted",
      error: `${OWNER_FOLLOW_UP_SUPERSEDE_PREFIX}wst_successor from the same owner workspace`,
    });
    hasPendingQueuedOrPreparingTurn.mockImplementation(() => false);
    await internal.drainTerminalAttention(parentId);

    const wakeCall = sendMessage.mock.calls.find(
      (call) => typeof call[1] === "string" && call[1].includes("wst_handle")
    );
    expect(wakeCall).toBeUndefined();
    expect(await attentionStore.get(parentId, staleVersionedId)).toMatchObject({
      status: "superseded",
    });
  });

  test("natural completion transfers disposable ownership to the queued same-owner follow-up", async () => {
    // Codex P1: a disposable predecessor that finishes naturally (finishReason
    // "stop") while a same-owner follow-up is queued — here turn-end, which
    // never cuts and is deliberately NOT supersede evidence — must still move
    // ownership: the follow-up dispatches at this stream end and would
    // otherwise lose its workspace to the settlement cleanup.
    const remove = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const { config, parentId, taskService, workspaceMocks } = await startWorkspaceTurnForTest(
      rootDir,
      {
        disposable: true,
        remove,
      }
    );
    const taskHandleStore = new TaskHandleStore(config);
    await taskHandleStore.upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, "childworkspace", "wst_successor", "queued", {
        turnId: "turn2",
        createdAt: "2026-08-11T00:00:00.000Z",
        updatedAt: "2026-08-11T00:00:00.000Z",
      })
    );
    workspaceMocks.getQueueCutCutter.mockImplementation(() => ({
      stage: "queued" as const,
      dispatchMode: "turn-end" as const,
      muxMetadata: workspaceTurnMuxMetadata(parentId, "wst_successor", "turn2"),
    }));

    await streamEnd(
      taskService,
      workspaceTurnStreamEndEvent(parentId, "msg_natural_completion", "Done")
    );

    expect(await taskHandleStore.getWorkspaceTurn(parentId, "wst_handle")).toMatchObject({
      status: "completed",
      disposableWorkspace: false,
    });
    expect(
      (await taskHandleStore.getWorkspaceTurn(parentId, "wst_successor"))?.disposableWorkspace
    ).toBe(true);
    expect(remove).not.toHaveBeenCalled();
  });

  test("quiet resettle deletes the stale direct-parent envelope generation", async () => {
    // Codex P2: an error settlement already delivered/queued the direct
    // parent's failure envelope; the later quiet resettle skips the
    // requiresDirectParentDelivery block (parent == owner), so it must
    // invalidate the stale direct-parent generation itself instead of leaving
    // the parent to wake on the corrected-away failure.
    const { config, parentId, taskService, workspaceMocks, projectPath } =
      await startWorkspaceTurnForTest(rootDir);
    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath);
      assert(project, "test project must exist");
      const child = project.workspaces.find((workspace) => workspace.id === "childworkspace");
      assert(child, "child workspace must exist");
      child.parentWorkspaceId = parentId;
      return cfg;
    });
    const taskHandleStore = new TaskHandleStore(config);
    const truncated = workspaceTurnStreamEndEvent(
      parentId,
      "msg_truncated_direct_parent",
      "Truncated",
      {
        finishReason: "length",
      }
    );
    truncated.metadata.historySequence = 1;
    await streamEnd(taskService, truncated);
    const errored = await taskHandleStore.getWorkspaceTurn(parentId, "wst_handle");
    assert(errored, "errored handle must exist");
    expect(errored.status).toBe("error");
    const attentionStore = new TerminalAttentionStore(config);
    const directParentGenerationId = TerminalAttentionStore.notificationId(
      "agent_task",
      "childworkspace",
      `wst_handle:error:${errored.updatedAt}`
    );
    await attentionStore.enqueueIfAbsent({
      ownerWorkspaceId: parentId,
      sourceKind: "agent_task",
      sourceId: "childworkspace",
      generationId: `wst_handle:error:${errored.updatedAt}`,
    });
    expect(await attentionStore.get(parentId, directParentGenerationId)).not.toBeNull();

    workspaceMocks.getQueueCutCutter.mockImplementation(() =>
      ownerFollowUpCutter(parentId, "wst_successor")
    );
    const successor = ownerFollowUpCutEvent(parentId, "msg_quiet_direct_parent_cut");
    // Durable ordering proves this cut follows the truncated response.
    successor.metadata.historySequence = 2;
    await streamEnd(taskService, successor);

    const resettled = await taskHandleStore.getWorkspaceTurn(parentId, "wst_handle");
    assert(resettled, "resettled handle must exist");
    expect(resettled.status).toBe("interrupted");
    expect(resettled.error?.startsWith(OWNER_FOLLOW_UP_SUPERSEDE_PREFIX)).toBe(true);
    expect(await attentionStore.get(parentId, directParentGenerationId)).toBeNull();
  });

  test("workspace-turn tool-calls stream-end defers to a streaming inherited continuation", async () => {
    // The wake already dispatched: the active stream (a newer messageId)
    // inherited this turn's correlation, proving the turn is continuing.
    const { parentId, taskService, aiMocks } = await startWorkspaceTurnForTest(rootDir);
    aiMocks.getStreamInfo.mockImplementation((workspaceId: string) =>
      workspaceId === "childworkspace"
        ? {
            messageId: "msg_continuation_active",
            model: "anthropic:claude-opus-4-6",
            historySequence: 2,
            startTime: Date.now(),
            parts: [],
            toolCompletionTimestamps: new Map(),
            muxMetadata: workspaceTurnMuxMetadata(parentId),
          }
        : undefined
    );

    await streamEnd(
      taskService,
      workspaceTurnStreamEndEvent(parentId, "msg_queue_cut_streaming", "Cut mid-work", {
        finishReason: "tool-calls",
      })
    );

    const snapshot = await workspaceTurnSnapshot(taskService, parentId);
    expect(snapshot).toMatchObject({ status: "running", workspaceId: "childworkspace" });
    expect(snapshot?.error).toBeUndefined();
  });

  test("uncorrelated compaction stream-end does not interrupt an active workspace turn", async () => {
    // On-send compaction can consume a monitor-wake continuation mid-turn; the
    // compact turn's own stream-end is uncorrelated and must not supersede the
    // still-running delegated turn. The compaction must NOT have transferred completion to a
    // durable follow-up: a transferred compaction returns before workspace-turn settlement, so
    // the uncorrelated-stream guard would never run.
    const { parentId, taskService, created } = await startWorkspaceTurnForTest(rootDir, {
      waitForPendingCompactionCompletionDecision: mock(() => Promise.resolve(false)),
    });

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: created.workspaceId,
      messageId: "msg_compaction_summary",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "compact",
        finishReason: "stop",
      },
      parts: [{ type: "text", text: "Compacted context" }],
    });

    const snapshot = await workspaceTurnSnapshot(taskService, parentId, created.taskId);
    expect(snapshot).toMatchObject({ status: "running", workspaceId: created.workspaceId });
    expect(snapshot?.error).toBeUndefined();
  });

  test("workspace-turn tool-calls stream-end without queue-cut evidence settles error", async () => {
    // A "tool-calls" finish without any queued/preparing/streaming successor is
    // not a queue cut (e.g. a successful required-tool stop condition); it must
    // keep the truncation error handling rather than claim a supersede.
    const { parentId, taskService } = await startWorkspaceTurnForTest(rootDir);

    await streamEnd(
      taskService,
      workspaceTurnStreamEndEvent(parentId, "msg_tool_calls_terminal", "Partial", {
        finishReason: "tool-calls",
      })
    );

    const snapshot = await workspaceTurnSnapshot(taskService, parentId);
    expect(snapshot).toMatchObject({
      status: "error",
      workspaceId: "childworkspace",
      messageId: "msg_tool_calls_terminal",
    });
    expect(snapshot?.error).toContain("unknown stop cause");
  });

  test("parent stream-end auto-resumes for active background workspace turns", async () => {
    const { parentId, taskService, workspaceMocks } = await startWorkspaceTurnForTest(rootDir);

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: parentId,
      messageId: "parent_msg_1",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
      },
      parts: [{ type: "text", text: "Parent done" }],
    });

    expect(workspaceMocks.sendMessage).toHaveBeenCalledTimes(2);
    expect(workspaceMocks.sendMessage.mock.calls[1]?.[0]).toBe(parentId);
    expect(workspaceMocks.sendMessage.mock.calls[1]?.[1]).toContain("wst_handle");
  });

  test("workspace-turn stream-end waits for active descendants before finalizing", async () => {
    const { config, parentId, projectPath, taskService, workspaceMocks } =
      await startWorkspaceTurnForTest(rootDir);
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

    await streamEnd(
      taskService,
      workspaceTurnStreamEndEvent(parentId, "msg_1", "Premature final text")
    );

    const snapshot = await workspaceTurnSnapshot(taskService, parentId);
    expect(snapshot).toMatchObject({ status: "running", workspaceId: "childworkspace" });
    expect(workspaceMocks.sendMessage).toHaveBeenCalledTimes(2);
    expect(workspaceMocks.sendMessage.mock.calls[1]?.[0]).toBe("childworkspace");
  });

  test("workspace-turn stream-end ignores nonblocking notify descendants", async () => {
    const { config, parentId, projectPath, taskService } = await startWorkspaceTurnForTest(rootDir);
    await config.editConfig((cfg) => {
      const project = Array.from(cfg.projects.values())[0];
      assert(project, "test project must exist");
      project.workspaces.push({
        path: path.join(projectPath, "notify-descendant-task"),
        id: "notify-descendant-task",
        name: "notify-descendant-task",
        createdAt: "2026-06-19T00:00:00.000Z",
        runtimeConfig: { type: "local" },
        parentWorkspaceId: "childworkspace",
        taskStatus: "running",
        taskAttentionPolicy: "notify_on_terminal",
      });
      return cfg;
    });

    await streamEnd(
      taskService,
      workspaceTurnStreamEndEvent(parentId, "msg_notify_only", "Final text despite background work")
    );

    const snapshot = await workspaceTurnSnapshot(taskService, parentId);
    expect(snapshot).toMatchObject({ status: "completed", workspaceId: "childworkspace" });
    expect(snapshot).not.toMatchObject({ deferredMessageIds: ["msg_notify_only"] });
  });

  test("workspace-turn stale recovery skips deferred pre-handoff stream-end history", async () => {
    const { config, parentId, projectPath, taskService, historyService } =
      await startWorkspaceTurnForTest(rootDir);
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
    const appendResult = await historyService.appendToHistory(
      "childworkspace",
      createMuxMessage("msg_prehandoff", "assistant", "Premature final text", {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata,
      })
    );
    expect(appendResult.success).toBe(true);

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_prehandoff",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata,
      },
      parts: [{ type: "text", text: "Premature final text" }],
    });

    expect(await workspaceTurnSnapshot(taskService, parentId)).toMatchObject({
      status: "running",
      deferredMessageIds: ["msg_prehandoff"],
    });
    workspaceTurnManagerInternals(taskService).activeWorkspaceTurnHandleByWorkspaceId.clear();
    const recovered = await workspaceTurnSnapshot(taskService, parentId);
    expect(recovered).toMatchObject({
      status: "interrupted",
      error: "Workspace turn interrupted after restart",
    });
    expect(recovered?.reportMarkdown).toBeUndefined();
  });

  test("workspace-turn stale recovery repairs restart-interrupted deferred handles after descendants stop blocking", async () => {
    const { config, parentId, projectPath, taskService, historyService, workspaceMocks } =
      await startWorkspaceTurnForTest(rootDir, { disposable: true });
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
    const appendResult = await historyService.appendToHistory(
      "childworkspace",
      createMuxMessage("msg_prehandoff", "assistant", "Recovered final text", {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata,
      })
    );
    expect(appendResult.success).toBe(true);

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_prehandoff",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata,
      },
      parts: [{ type: "text", text: "Recovered final text" }],
    });
    workspaceTurnManagerInternals(taskService).activeWorkspaceTurnHandleByWorkspaceId.clear();
    expect(await workspaceTurnSnapshot(taskService, parentId)).toMatchObject({
      status: "interrupted",
      error: "Workspace turn interrupted after restart",
    });

    await config.editConfig((cfg) => {
      const descendant = Array.from(cfg.projects.values())
        .flatMap((project) => project.workspaces)
        .find((workspace) => workspace.id === "descendant-task");
      assert(descendant, "descendant task must exist");
      descendant.archivedAt = "2026-06-19T00:01:00.000Z";
      return cfg;
    });

    const repaired = await workspaceTurnSnapshot(taskService, parentId);
    expect(repaired).toMatchObject({
      status: "completed",
      messageId: "msg_prehandoff",
      reportMarkdown: "Recovered final text",
    });
    expect(repaired?.error).toBeUndefined();
    expect(workspaceMocks.remove).toHaveBeenCalledWith("childworkspace", true);
  });

  test("correlated stream-end corrects a stale error settlement after self-healed retry", async () => {
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
    await new TaskHandleStore(config).upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, "childworkspace", "wst_handle", "error", {
        createdWorkspace: true,
        directParentResultDeliveryRequiredAt: "2026-06-19T00:00:01.500Z",
        directParentResultDeliveredAt: "2026-06-19T00:00:01.750Z",
        error: "Stream error: provider overloaded",
        terminalAttentionNotifiedAt: "2026-06-19T00:00:02.000Z",
      })
    );
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_retry_final",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata,
      },
      parts: [{ type: "text", text: "Recovered after retry" }],
    });

    const snapshot = await workspaceTurnSnapshot(taskService, parentId);
    expect(snapshot).toMatchObject({
      status: "completed",
      messageId: "msg_retry_final",
      reportMarkdown: "Recovered after retry",
    });
    expect(snapshot?.directParentResultDeliveryRequiredAt).toBeDefined();
    expect(snapshot?.directParentResultDeliveredAt).toBeDefined();
    expect(snapshot?.directParentResultDeliveredAt).not.toBe("2026-06-19T00:00:01.750Z");
    const parentHistory = await historyService.getHistoryFromLatestBoundary(parentId);
    expect(JSON.stringify(parentHistory)).toContain("Recovered after retry");
    expect(snapshot?.error).toBeUndefined();
    expect(snapshot?.terminalAttentionNotifiedAt).toBeUndefined();
  });

  test("resettled workspace turn re-arms a consumed notify_on_terminal wake-up", async () => {
    const { config, parentId, taskService } = await startWorkspaceTurnForTest(rootDir);
    await new TaskHandleStore(config).upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, "childworkspace", "wst_handle", "error", {
        createdWorkspace: true,
        error: "Stream error: provider overloaded",
        attentionPolicy: "notify_on_terminal",
        terminalAttentionNotifiedAt: "2026-06-19T00:00:02.000Z",
      })
    );
    // The stale error's wake-up was already delivered; without the tombstone reset,
    // enqueueIfAbsent would swallow the corrected outcome's notification.
    const terminalAttentionStore = new TerminalAttentionStore(config);
    await terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: parentId,
      sourceKind: "workspace_turn",
      sourceId: "wst_handle",
    });
    await terminalAttentionStore.markDelivered(parentId, "workspace_turn:wst_handle");
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_retry_final",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata,
      },
      parts: [{ type: "text", text: "Recovered after retry" }],
    });

    const corrected = await workspaceTurnSnapshot(taskService, parentId);
    expect(corrected).toMatchObject({
      status: "completed",
      reportMarkdown: "Recovered after retry",
    });
    assert(corrected, "corrected workspace-turn record must exist");
    const correctedAttentionId = TerminalAttentionStore.notificationId(
      "workspace_turn",
      corrected.handleId,
      `${corrected.handleId}:${corrected.status}:${corrected.updatedAt}`
    );
    // A stale drain completing after replacement can only transition the legacy ID; the corrected
    // generation remains independently persisted and therefore cannot be swallowed.
    await terminalAttentionStore.markDelivered(parentId, "workspace_turn:wst_handle");
    expect(await terminalAttentionStore.get(parentId, correctedAttentionId)).not.toBeNull();
  });

  test("duplicate correlated stream-end replay keeps a settled error handle unchanged", async () => {
    const { config, parentId, taskService } = await startWorkspaceTurnForTest(rootDir);
    await new TaskHandleStore(config).upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, "childworkspace", "wst_handle", "error", {
        createdWorkspace: true,
        messageId: "msg_truncated_replay",
        error: "Workspace turn ended before completion (finishReason: length)",
        terminalAttentionNotifiedAt: "2026-06-19T00:00:02.000Z",
      })
    );
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_truncated_replay",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "length",
        muxMetadata,
      },
      parts: [{ type: "text", text: "Partial text" }],
    });

    const snapshot = await workspaceTurnSnapshot(taskService, parentId);
    expect(snapshot).toMatchObject({
      status: "error",
      messageId: "msg_truncated_replay",
      updatedAt: "2026-06-19T00:00:01.000Z",
      terminalAttentionNotifiedAt: "2026-06-19T00:00:02.000Z",
    });
  });

  test("late correlated stream-end does not resettle an explicitly interrupted workspace turn", async () => {
    const { config, parentId, taskService } = await startWorkspaceTurnForTest(rootDir);
    // Explicit interrupt (user Esc / task_terminate): status interrupted WITHOUT the
    // stale-restart marker. An in-flight stream-end completing after the cancel must not
    // make the canceled turn appear completed.
    await new TaskHandleStore(config).upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, "childworkspace", "wst_handle", "interrupted", {
        createdWorkspace: true,
      })
    );
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_late_final",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata,
      },
      parts: [{ type: "text", text: "Late final text" }],
    });

    expect(await workspaceTurnSnapshot(taskService, parentId)).toMatchObject({
      status: "interrupted",
      updatedAt: "2026-06-19T00:00:01.000Z",
    });
  });

  test("correlated stream-end never overwrites a completed workspace turn", async () => {
    const { config, parentId, taskService } = await startWorkspaceTurnForTest(rootDir);
    await new TaskHandleStore(config).upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, "childworkspace", "wst_handle", "completed", {
        createdWorkspace: true,
        messageId: "msg_first",
        reportMarkdown: "First result",
      })
    );
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_second",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata,
      },
      parts: [{ type: "text", text: "Second result" }],
    });

    expect(await workspaceTurnSnapshot(taskService, parentId)).toMatchObject({
      status: "completed",
      messageId: "msg_first",
      reportMarkdown: "First result",
    });
  });

  test("direct-parent consumption suppresses a concurrently resettled workspace-turn wake", async () => {
    const { config, parentId, taskService } = await startWorkspaceTurnForTest(rootDir);
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
      attentionPolicy: "notify_on_terminal",
      terminalAttentionNotifiedAt: "2026-06-19T00:00:02.000Z",
    };
    await new TaskHandleStore(config).upsertWorkspaceTurn(staleRecord);
    const terminalAttentionStore = new TerminalAttentionStore(config);
    await terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: parentId,
      sourceKind: "workspace_turn",
      sourceId: "wst_handle",
      terminalOutcome: "error",
    });
    await terminalAttentionStore.markDelivered(parentId, "workspace_turn:wst_handle");

    let releasePostSettlementDelivery: () => void = () => undefined;
    const postSettlementDeliveryBlocked = new Promise<void>((resolve) => {
      releasePostSettlementDelivery = resolve;
    });
    let signalPostSettlementDelivery: () => void = () => undefined;
    const postSettlementDeliveryStarted = new Promise<void>((resolve) => {
      signalPostSettlementDelivery = resolve;
    });
    const internal = workspaceTurnManagerFor(taskService) as unknown as {
      deliverPersistentChildWorkspaceTurnResult: (
        record: WorkspaceTurnTaskHandleRecord,
        waiterWorkspaceIds: ReadonlySet<string>
      ) => Promise<void>;
    };
    const deliverPersistentChildWorkspaceTurnResult =
      internal.deliverPersistentChildWorkspaceTurnResult.bind(workspaceTurnManagerFor(taskService));
    const delivery = spyOn(
      internal,
      "deliverPersistentChildWorkspaceTurnResult"
    ).mockImplementation(async (record, waiterWorkspaceIds) => {
      // Preserve the production direct-parent report/marker path, then pause before
      // settleWorkspaceTurn can re-arm the corrected private workspace-turn wake.
      await deliverPersistentChildWorkspaceTurnResult(record, waiterWorkspaceIds);
      signalPostSettlementDelivery();
      await postSettlementDeliveryBlocked;
    });
    const settling = streamEnd(
      taskService,
      workspaceTurnStreamEndEvent(
        parentId,
        "msg_concurrent_resettle",
        "Concurrently corrected result"
      )
    );

    try {
      await postSettlementDeliveryStarted;
      const snapshot = await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(
        parentId,
        "wst_handle",
        {
          consumingWorkspaceId: parentId,
        }
      );
      expect(snapshot).toMatchObject({
        status: "completed",
        messageId: "msg_concurrent_resettle",
        reportMarkdown: "Concurrently corrected result",
      });
      expect(snapshot?.directParentResultDeliveredAt).toBeDefined();
      expect(snapshot?.terminalAttentionNotifiedAt).toBeDefined();
    } finally {
      releasePostSettlementDelivery();
      await settling;
      delivery.mockRestore();
    }

    expect(await terminalAttentionStore.get(parentId, "workspace_turn:wst_handle")).toMatchObject({
      status: "delivered",
    });
    expect(
      (await terminalAttentionStore.listPending(parentId)).filter(
        (notification) => notification.sourceKind === "workspace_turn"
      )
    ).toEqual([]);
  });

  test("workspace-turn stale recovery uses deferred history after archived descendants stop blocking", async () => {
    const { config, parentId, projectPath, taskService, historyService } =
      await startWorkspaceTurnForTest(rootDir);
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
    const appendResult = await historyService.appendToHistory(
      "childworkspace",
      createMuxMessage("msg_prehandoff", "assistant", "Premature final text", {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata,
      })
    );
    expect(appendResult.success).toBe(true);

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_prehandoff",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata,
      },
      parts: [{ type: "text", text: "Premature final text" }],
    });

    expect(await workspaceTurnSnapshot(taskService, parentId)).toMatchObject({
      status: "running",
      deferredMessageIds: ["msg_prehandoff"],
    });

    await config.editConfig((cfg) => {
      const descendant = Array.from(cfg.projects.values())
        .flatMap((project) => project.workspaces)
        .find((workspace) => workspace.id === "descendant-task");
      assert(descendant, "descendant task must exist");
      descendant.archivedAt = "2026-06-19T00:01:00.000Z";
      return cfg;
    });

    const recovered = await workspaceTurnSnapshot(taskService, parentId);
    expect(recovered).toMatchObject({
      status: "completed",
      messageId: "msg_prehandoff",
      reportMarkdown: "Premature final text",
    });
    expect(recovered?.deferredMessageIds).toBeUndefined();
  });

  test("workspace-turn deferred recovery waits for active workflow blockers", async () => {
    const { config, parentId, taskService, historyService } =
      await startWorkspaceTurnForTest(rootDir);
    const runStore = new WorkflowRunStore({
      sessionDir: path.join(config.sessionsDir, "childworkspace"),
    });
    await runStore.createRun({
      id: "wfr_child_background",
      workspaceId: "childworkspace",
      workflow: {
        name: "child-background",
        description: "Child background workflow",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      now: "2026-06-19T00:00:00.000Z",
    });
    await runStore.appendStatus("wfr_child_background", "running", "2026-06-19T00:00:01.000Z");
    await recordAgentWorkflowRunReference({
      workspaceSessionDir: path.join(config.sessionsDir, "childworkspace"),
      runId: "wfr_child_background",
      createdAtMs: Date.parse("2026-06-19T00:00:01.000Z"),
    });

    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    const appendResult = await historyService.appendToHistory(
      "childworkspace",
      createMuxMessage("msg_workflow_blocked", "assistant", "Workflow-blocked final text", {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata,
      })
    );
    expect(appendResult.success).toBe(true);

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_workflow_blocked",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata,
      },
      parts: [{ type: "text", text: "Workflow-blocked final text" }],
    });

    expect(await workspaceTurnSnapshot(taskService, parentId)).toMatchObject({
      status: "running",
      deferredMessageIds: ["msg_workflow_blocked"],
    });

    await runStore.appendStatus("wfr_child_background", "completed", "2026-06-19T00:00:02.000Z");
    const recovered = await workspaceTurnSnapshot(taskService, parentId);
    expect(recovered).toMatchObject({
      status: "completed",
      messageId: "msg_workflow_blocked",
      reportMarkdown: "Workflow-blocked final text",
    });
  });

  test("workspace-turn auto-resume preserves handle metadata", async () => {
    const { config, parentId, projectPath, taskService, workspaceMocks } =
      await startWorkspaceTurnForTest(rootDir);
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

    await streamEnd(
      taskService,
      workspaceTurnStreamEndEvent(parentId, "msg_1", "Premature final text")
    );

    expect(workspaceMocks.sendMessage).toHaveBeenCalledTimes(2);
    expect(workspaceMocks.sendMessage.mock.calls[1]?.[2]).toMatchObject({
      muxMetadata: workspaceTurnMuxMetadata(parentId),
    });
  });

  test("workspace-turn stream-end ignores unrelated mux metadata", async () => {
    const { parentId, taskService } = await startWorkspaceTurnForTest(rootDir);

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "compaction_msg",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata: { type: "compaction-request", rawCommand: "/compact", parsed: {} },
      },
      parts: [{ type: "text", text: "Compaction summary" }],
    });

    const snapshot = await workspaceTurnSnapshot(taskService, parentId);
    expect(snapshot).toMatchObject({ status: "running", workspaceId: "childworkspace" });
  });

  test("workspace-turn stream-end without correlation metadata interrupts the active handle", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["handle", "turn"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);

    const createWorkspace = makeWorkspaceTurnCreateMock(config, projectPath);
    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const created = await workspaceTurnManagerFor(taskService).createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Summarize",
      title: "Workspace turn",
      workspace: { mode: "new" },
    });
    expect(created.success).toBe(true);

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_1",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
      },
      parts: [{ type: "text", text: "Done without correlation metadata" }],
    });

    const snapshot = await workspaceTurnSnapshot(taskService, parentId);
    expect(snapshot).toMatchObject({
      status: "interrupted",
      workspaceId: "childworkspace",
      messageId: "msg_1",
      error: "Workspace turn superseded by an uncorrelated workspace stream-end",
    });
    expect(snapshot?.reportMarkdown).toBeUndefined();
  });

  test("workspace-turn system stream aborts keep the handle running for resume", async () => {
    const { parentId, taskService } = await startWorkspaceTurnForTest(rootDir);

    await streamAbort(taskService, {
      type: "stream-abort",
      workspaceId: "childworkspace",
      messageId: "msg_system_abort",
      abortReason: "system",
    });
    expect(await workspaceTurnSnapshot(taskService, parentId)).toMatchObject({
      status: "running",
      workspaceId: "childworkspace",
    });

    await streamEnd(
      taskService,
      workspaceTurnStreamEndEvent(parentId, "msg_resumed", "Resumed done")
    );
    expect(await workspaceTurnSnapshot(taskService, parentId)).toMatchObject({
      status: "completed",
      messageId: "msg_resumed",
      reportMarkdown: "Resumed done",
    });
  });

  test("workspace-turn stream aborts mark the handle interrupted", async () => {
    const { parentId, taskService } = await startWorkspaceTurnForTest(rootDir);

    await streamAbort(taskService, {
      type: "stream-abort",
      workspaceId: "childworkspace",
      messageId: "msg_1",
      abortReason: "user",
    });

    const snapshot = await workspaceTurnSnapshot(taskService, parentId);
    expect(snapshot).toMatchObject({
      status: "interrupted",
      workspaceId: "childworkspace",
    });
  });

  test("waitForWorkspaceTurn handles completion racing with waiter registration", async () => {
    const { parentId, taskService } = await startWorkspaceTurnForTest(rootDir);
    const store = workspaceTurnManagerInternals(taskService).taskHandleStore;
    const originalGetWorkspaceTurn = store.getWorkspaceTurn.bind(store);
    const completionHandled = Promise.withResolvers<void>();
    const abortController = new AbortController();
    let triggered = false;
    const getWorkspaceTurnSpy = spyOn(store, "getWorkspaceTurn").mockImplementation(
      async (ownerWorkspaceId: string, handleId: string) => {
        const record = await originalGetWorkspaceTurn(ownerWorkspaceId, handleId);
        if (!triggered && handleId === "wst_handle" && record?.status === "running") {
          triggered = true;
          await streamEnd(taskService, workspaceTurnStreamEndEvent(parentId, "msg_1", "Done"));
          completionHandled.resolve();
        }
        return record;
      }
    );

    const reportPromise = workspaceTurnManagerFor(taskService).waitForWorkspaceTurn("wst_handle", {
      requestingWorkspaceId: parentId,
      abortSignal: abortController.signal,
    });
    reportPromise.catch(completionHandled.reject);

    try {
      await completionHandled.promise;
      // Completion must reach the waiter before the initial read returns its stale running record.
      // Abort a missed notification deterministically instead of racing slow I/O against a short timer.
      abortController.abort();
      const report = await reportPromise;
      expect(triggered).toBe(true);
      expect(report.reportMarkdown).toBe("Done");
    } finally {
      abortController.abort();
      getWorkspaceTurnSpy.mockRestore();
    }
  });

  test("workspace-turn terminal settlements do not overwrite each other", async () => {
    const completed = await startWorkspaceTurnForTest(rootDir);
    const staleRunningRecord = await workspaceTurnSnapshot(
      completed.taskService,
      completed.parentId
    );
    assert(staleRunningRecord, "expected running workspace-turn record");
    await streamEnd(
      completed.taskService,
      workspaceTurnStreamEndEvent(completed.parentId, "msg_done", "Done")
    );
    await (
      workspaceTurnManagerFor(completed.taskService) as unknown as {
        settleWorkspaceTurn: (params: unknown) => Promise<void>;
      }
    ).settleWorkspaceTurn({
      cause: { kind: "user-stream-abort" },
      record: staleRunningRecord,
      next: {
        ...staleRunningRecord,
        status: "interrupted",
        updatedAt: "2026-06-19T00:00:01.000Z",
      },
      waiterSettlement: { status: "error", error: new Error("late interrupt") },
    });
    expect(await workspaceTurnSnapshot(completed.taskService, completed.parentId)).toMatchObject({
      status: "completed",
      messageId: "msg_done",
      reportMarkdown: "Done",
    });

    const interrupted = await startWorkspaceTurnForTest(rootDir, {
      stableIds: ["secondhandle", "secondturn"],
    });
    const staleInterruptedRecord = await workspaceTurnSnapshot(
      interrupted.taskService,
      interrupted.parentId,
      "wst_secondhandle"
    );
    assert(staleInterruptedRecord, "expected second running workspace-turn record");
    await interrupted.config.editConfig((cfg) => {
      const project = cfg.projects.get(interrupted.projectPath);
      const child = project?.workspaces.find((workspace) => workspace.id === "childworkspace");
      assert(child, "workspace-turn child must exist");
      child.parentWorkspaceId = interrupted.parentId;
      child.taskStatus = "reported";
      child.taskExecutionId = "wst_secondhandle";
      child.taskExecutionStatus = "running";
      return cfg;
    });
    const interruptResult = await workspaceTurnManagerFor(
      interrupted.taskService
    ).interruptWorkspaceTurn(interrupted.parentId, "wst_secondhandle");
    expect(interruptResult.success).toBe(true);
    await (
      workspaceTurnManagerFor(interrupted.taskService) as unknown as {
        settleWorkspaceTurn: (params: unknown) => Promise<void>;
      }
    ).settleWorkspaceTurn({
      cause: { kind: "correlated-stream-end" },
      record: staleInterruptedRecord,
      next: {
        ...staleInterruptedRecord,
        status: "completed",
        updatedAt: "2026-06-19T00:00:01.000Z",
        messageId: "msg_late_done",
        reportMarkdown: "Late done",
      },
      waiterSettlement: {
        status: "completed",
        result: {
          taskId: "wst_secondhandle",
          workspaceId: "childworkspace",
          reportMarkdown: "Late done",
        },
      },
    });
    const interruptedSnapshot = await workspaceTurnSnapshot(
      interrupted.taskService,
      interrupted.parentId,
      "wst_secondhandle"
    );
    expect(interruptedSnapshot).toMatchObject({ status: "interrupted" });
    expect(findWorkspaceInConfig(interrupted.config, "childworkspace")?.taskExecutionStatus).toBe(
      "interrupted"
    );
    expect(interruptedSnapshot?.reportMarkdown).toBeUndefined();
  });

  test("disposable workspace turns are removed after completion, error, or interruption", async () => {
    const completedRemove = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const completed = await startWorkspaceTurnForTest(rootDir, {
      disposable: true,
      remove: completedRemove,
    });
    await streamEnd(
      completed.taskService,
      workspaceTurnStreamEndEvent(completed.parentId, "msg_completed", "Done")
    );
    expect(completedRemove).toHaveBeenCalledWith("childworkspace", true);

    const errorRemove = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const failed = await startWorkspaceTurnForTest(rootDir, {
      disposable: true,
      remove: errorRemove,
    });
    await streamError(failed.taskService, {
      type: "error",
      workspaceId: "childworkspace",
      messageId: "msg_error",
      error: "Provider failed",
      errorType: "authentication",
    });
    expect(errorRemove).toHaveBeenCalledWith("childworkspace", true);

    const interruptedRemove = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const interrupted = await startWorkspaceTurnForTest(rootDir, {
      disposable: true,
      remove: interruptedRemove,
      isStreaming: mock(() => true),
    });
    const interruptResult = await workspaceTurnManagerFor(
      interrupted.taskService
    ).interruptWorkspaceTurn(interrupted.parentId, "wst_handle");
    expect(interruptResult.success).toBe(true);
    expect(interruptedRemove).toHaveBeenCalledWith("childworkspace", true);
  });

  test("markBackgroundWorkNotifyOnTerminal wakes for terminal workspace-turn records", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const handleId = "wst_timeout_race";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId, {
          aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });
    const taskHandleStore = new TaskHandleStore(config);
    await taskHandleStore.upsertWorkspaceTurn(
      workspaceTurnRecord(rootWorkspaceId, "childworkspace", handleId, "completed", {
        reportMarkdown: "Done before notify policy persisted",
      })
    );

    // Simulates the race Codex caught: the workspace turn settled before the queued/timeout detach
    // persisted notify_on_terminal, so the persistence helper must enqueue the missing wake-up.
    await taskService.markBackgroundWorkNotifyOnTerminal(handleId, rootWorkspaceId);
    await flushTerminalAttentionDrains(taskService);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(String(sendMessage.mock.calls[0]?.[1])).toContain(handleId);
    expect(String(sendMessage.mock.calls[0]?.[1])).toContain("timeout_secs: 0");
    const snapshot = await workspaceTurnSnapshot(taskService, rootWorkspaceId, handleId);
    expect(snapshot?.attentionPolicy).toBe("notify_on_terminal");
    expect(snapshot?.terminalAttentionNotifiedAt).toBeDefined();
  });
});
