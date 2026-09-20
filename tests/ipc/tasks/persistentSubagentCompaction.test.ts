import { cleanupTestEnvironment, createTestEnvironment, type TestEnvironment } from "../setup";
import {
  cleanupTempGitRepo,
  createTempGitRepo,
  createWorkspace,
  generateBranchName,
  HAIKU_MODEL,
  sendMessageWithModel,
  waitFor,
} from "../helpers";

import { buildMockStreamStartGateMessage } from "@/node/services/mock/mockAiRouter";
import type { Workspace as WorkspaceConfigEntry } from "@/node/config";
import { HistoryService } from "@/node/services/historyService";
import type { MuxMessage } from "@/common/types/message";
import { Err } from "@/common/types/result";
import { TASK_ATTEMPT_SETTLED_SEND_BLOCKED_MESSAGE } from "@/constants/agentMessaging";

function extractText(message: MuxMessage): string {
  return message.parts
    .filter(
      (part): part is Extract<MuxMessage["parts"][number], { type: "text" }> => part.type === "text"
    )
    .map((part) => part.text)
    .join("");
}

function findWorkspace(
  env: TestEnvironment,
  workspaceId: string
): WorkspaceConfigEntry | undefined {
  return Array.from(env.config.loadConfigOrDefault().projects.values())
    .flatMap((project) => project.workspaces)
    .find((workspace) => workspace.id === workspaceId);
}

describe("Persistent sub-agent compaction", () => {
  let env: TestEnvironment | undefined;
  let repoPath: string | undefined;
  const workspaceIds: string[] = [];

  beforeEach(async () => {
    env = await createTestEnvironment();
    env.services.aiService.enableMockMode();
    repoPath = await createTempGitRepo();
  });

  afterEach(async () => {
    if (env) {
      for (const workspaceId of workspaceIds.splice(0).reverse()) {
        try {
          await env.orpc.workspace.remove({ workspaceId, options: { force: true } });
        } catch {
          // Best-effort cleanup.
        }
      }
      await cleanupTestEnvironment(env);
      env = undefined;
    }
    if (repoPath) {
      await cleanupTempGitRepo(repoPath);
      repoPath = undefined;
    }
  });

  test.each([false, true])(
    "rejected reactivation keeps its published attempt until a Stop settles it (busy at creation: %s)",
    async (busyAtCreation) => {
      if (!env || !repoPath) throw new Error("Test environment not initialized");
      const parent = await createWorkspace(
        env,
        repoPath,
        generateBranchName("reactivation-parent")
      );
      if (!parent.success) throw new Error(parent.error);
      const parentId = parent.metadata.id;
      workspaceIds.push(parentId);
      const child = await createWorkspace(env, repoPath, generateBranchName("reactivation-child"));
      if (!child.success) throw new Error(child.error);
      const childId = child.metadata.id;
      workspaceIds.push(childId);
      await env.config.addWorkspace(repoPath, {
        ...child.metadata,
        parentWorkspaceId: parentId,
        agentId: "explore",
        agentType: "explore",
        taskStatus: "interrupted",
        taskModelString: HAIKU_MODEL,
        title: "Reviewer",
      });
      const { taskService, workspaceService, workspaceTurnManager } = env.services;
      const requesting = { requestingWorkspaceId: parentId };
      expect(await taskService.markInterruptedTaskRunning(childId)).toBe(true);
      await taskService.terminateAllDescendantAgentTasks(parentId);
      expect(await taskService.readAttemptOutcome(childId, requesting)).toEqual({
        kind: "terminal-no-report",
      });
      const retiredAttemptId = findWorkspace(env, childId)?.taskAttemptId;
      expect(retiredAttemptId).toMatch(/^att_[0-9a-f]{16}$/);

      // Keep TaskService, WorkspaceTurnManager and WorkspaceService real: the refusal comes from
      // the real createWorkspaceTurn path, which fails only AFTER the reactivation published its
      // fresh attempt. A refusal there proves nothing about admission (the send may already have
      // happened), so the fresh identity is never rolled back to the retired attempt: it reads as
      // owned-but-unsettled until a Stop settles it.
      const session = workspaceService.getOrCreateSession(childId);
      // The WTM busy snapshot may become idle before WorkspaceService reaches admission.
      const busy = jest
        .spyOn(workspaceService, "isBusyForMessage")
        .mockReturnValueOnce(busyAtCreation);
      const send = jest
        .spyOn(session, "sendMessage")
        .mockResolvedValueOnce(Err({ type: "unknown", raw: "session admission refused" }));
      try {
        expect(
          await taskService.sendMessageToDescendantAgentTask(
            parentId,
            childId,
            "Rejected follow-up",
            "tool-end"
          )
        ).toMatchObject({ success: false, error: { code: "send_failed" } });
        expect(send).toHaveBeenCalledTimes(1);
        const published = findWorkspace(env, childId)?.taskAttemptId;
        expect(published).toMatch(/^att_[0-9a-f]{16}$/);
        expect(published).not.toBe(retiredAttemptId);
        const outcome = await taskService.readAttemptOutcome(childId, requesting);
        expect(outcome.kind).toBe("indeterminate");
        if (outcome.kind === "indeterminate") {
          expect(outcome.reason).toContain("without settlement evidence");
        }
        // Only a Stop settles the published attempt; its id stays exactly as published.
        await taskService.terminateAllDescendantAgentTasks(parentId);
        expect(await taskService.readAttemptOutcome(childId, requesting)).toEqual({
          kind: "terminal-no-report",
        });
        expect(findWorkspace(env, childId)?.taskAttemptId).toBe(published);
      } finally {
        send.mockRestore();
        busy.mockRestore();
      }

      // A real accepted follow-up must still complete under WTM ownership, without the manual
      // interrupted-task rescue. This guards against fixing refusal by breaking successful sends.
      const acceptedBusy = jest
        .spyOn(workspaceService, "isBusyForMessage")
        .mockReturnValueOnce(busyAtCreation);
      try {
        const reactivated = await taskService.sendMessageToDescendantAgentTask(
          parentId,
          childId,
          "Accepted follow-up",
          "tool-end"
        );
        if (!reactivated.success || reactivated.data.executionTaskId == null) {
          throw new Error("Expected a reactivated execution");
        }
        const result = await workspaceTurnManager.waitForWorkspaceTurn(
          reactivated.data.executionTaskId,
          { ...requesting, backgroundOnMessageQueued: false, timeoutMs: 10_000 }
        );
        expect(result.reportMarkdown).toContain("Accepted follow-up");
      } finally {
        acceptedBusy.mockRestore();
      }
    },
    25_000
  );

  test.each(["tool-end", "turn-end"] as const)(
    "parent guidance stays attached to a reawakened execution with %s dispatch",
    async (queueDispatchMode) => {
      if (!env || !repoPath) throw new Error("Test environment not initialized");
      const testEnv = env;
      const parent = await createWorkspace(env, repoPath, generateBranchName("guidance-parent"));
      if (!parent.success) throw new Error(parent.error);
      const parentId = parent.metadata.id;
      workspaceIds.push(parentId);
      const child = await createWorkspace(env, repoPath, generateBranchName("guidance-child"));
      if (!child.success) throw new Error(child.error);
      const childId = child.metadata.id;
      workspaceIds.push(childId);
      await env.config.addWorkspace(repoPath, {
        ...child.metadata,
        parentWorkspaceId: parentId,
        agentId: "explore",
        agentType: "explore",
        taskStatus: "reported",
        taskModelString: HAIKU_MODEL,
        title: "Reviewer",
      });
      const historyService = new HistoryService(env.config);
      const reactivated = await env.services.taskService.sendMessageToDescendantAgentTask(
        parentId,
        childId,
        buildMockStreamStartGateMessage("Review the initial changes."),
        "tool-end"
      );
      if (!reactivated.success || reactivated.data.delivery !== "reactivated") {
        throw new Error("Expected a reactivated child execution");
      }
      const handleId = reactivated.data.executionTaskId;
      if (!handleId) throw new Error("Expected a reactivated execution task ID");
      try {
        // Hold the real session at stream preparation, so guidance deterministically queues.
        expect(
          await waitFor(
            () => testEnv.services.workspaceService.getOrCreateSession(childId).isPreparingTurn(),
            10_000
          )
        ).toBe(true);
        const guidance = await env.services.taskService.sendMessageToDescendantAgentTask(
          parentId,
          childId,
          "Check lifecycle behavior before reporting.",
          queueDispatchMode
        );
        const correlation =
          await env.services.workspaceTurnManager.getActiveWorkspaceTurnMuxMetadataForWorkspace(
            childId
          );
        if (!correlation) throw new Error("Missing active correlation");
        expect(
          env.services.workspaceService.hasPendingWorkspaceTurnContinuation(childId, correlation)
        ).toBe(true);
        expect(guidance).toMatchObject({ success: true, data: { delivery: "queued" } });
      } finally {
        env.services.aiService.releaseMockStreamStartGate(childId);
      }

      expect(
        await waitFor(async () => {
          const snapshot =
            await testEnv.services.taskService.getDescendantAgentTaskExecutionSnapshot(
              parentId,
              childId
            );
          return (
            snapshot?.record.status === "completed" ||
            snapshot?.record.status === "interrupted" ||
            snapshot?.record.status === "error"
          );
        }, 15_000)
      ).toBe(true);
      const result = await env.services.workspaceTurnManager.waitForWorkspaceTurn(handleId, {
        requestingWorkspaceId: parentId,
        backgroundOnMessageQueued: false,
        timeoutMs: 10_000,
      });
      expect(result.reportMarkdown).toContain("Check lifecycle behavior before reporting.");
      expect(findWorkspace(env, childId)).toMatchObject({
        taskExecutionId: handleId,
        taskExecutionStatus: "completed",
      });
      expect(
        await waitFor(async () => {
          const history = await historyService.getLastMessages(parentId, 30);
          return (
            history.success &&
            history.data.some((message) => extractText(message).includes("<mux_subagent_report>"))
          );
        }, 10_000)
      ).toBe(true);
      const parentHistory = await historyService.getLastMessages(parentId, 30);
      if (!parentHistory.success) throw new Error(parentHistory.error);
      const reports = parentHistory.data.filter((message) =>
        extractText(message).includes("<mux_subagent_report>")
      );
      expect(reports).toHaveLength(1);
      expect(extractText(reports[0])).toContain("Check lifecycle behavior before reporting.");
      expect(
        parentHistory.data.some((message) =>
          extractText(message).includes("<mux_subagent_failure>")
        )
      ).toBe(false);
    }
  );

  /**
   * Remote UAT (round 5): the parent reawakens an inactive child through task_send_message
   * (reactivation → WorkspaceTurnManager continuation), a parent Stop cascade settles that
   * reactivation attempt, and the user then recovers the child manually. Both manual entry
   * points must start a NEW attempt — the settled reactivation attempt stays closed.
   */
  async function recoverManuallyAfterCascade(
    predecessorStatus: "reported" | "interrupted",
    recovery: "sendMessage" | "resumeStream"
  ): Promise<void> {
    if (!env || !repoPath) throw new Error("Test environment not initialized");
    const testEnv = env;
    const parent = await createWorkspace(env, repoPath, generateBranchName("recovery-parent"));
    if (!parent.success) throw new Error(parent.error);
    const parentId = parent.metadata.id;
    workspaceIds.push(parentId);
    const child = await createWorkspace(env, repoPath, generateBranchName("recovery-child"));
    if (!child.success) throw new Error(child.error);
    const childId = child.metadata.id;
    workspaceIds.push(childId);
    const reportedAt = "2026-08-10T12:00:00.000Z";
    await env.config.addWorkspace(repoPath, {
      ...child.metadata,
      parentWorkspaceId: parentId,
      agentId: "explore",
      agentType: "explore",
      taskStatus: predecessorStatus,
      ...(predecessorStatus === "reported" ? { reportedAt } : {}),
      taskModelString: HAIKU_MODEL,
      title: "Reviewer",
    });
    const { taskService, workspaceService, aiService } = env.services;

    const reactivated = await taskService.sendMessageToDescendantAgentTask(
      parentId,
      childId,
      buildMockStreamStartGateMessage("Continue the review."),
      "tool-end"
    );
    if (!reactivated.success || reactivated.data.delivery !== "reactivated") {
      throw new Error(`Expected a reactivated child execution: ${JSON.stringify(reactivated)}`);
    }
    const handleId = reactivated.data.executionTaskId;
    if (!handleId) throw new Error("Expected a reactivated execution task ID");
    const reactivationAttemptId = findWorkspace(env, childId)?.taskAttemptId;
    expect(reactivationAttemptId).toMatch(/^att_[0-9a-f]{16}$/);
    // The continuation is live (held at the mock stream-start gate) when the cascade lands.
    expect(
      await waitFor(
        () =>
          aiService.isStreaming(childId) ||
          workspaceService.getOrCreateSession(childId).isPreparingTurn(),
        10_000
      )
    ).toBe(true);

    await taskService.terminateAllDescendantAgentTasks(parentId);
    aiService.releaseMockStreamStartGate(childId);
    expect(await waitFor(() => !taskService.isWorkspaceStopInProgress(childId), 15_000)).toBe(true);
    expect(findWorkspace(env, childId)).toMatchObject({
      taskAttemptId: reactivationAttemptId,
      taskExecutionId: handleId,
      taskExecutionStatus: "interrupted",
    });
    expect(aiService.isStreaming(childId)).toBe(false);

    // Manual recovery must start a NEW attempt: the settled reactivation attempt stays closed.
    const result =
      recovery === "sendMessage"
        ? await sendMessageWithModel(env, childId, "Manual follow-up after the stop.", HAIKU_MODEL)
        : await env.orpc.workspace.resumeStream({
            workspaceId: childId,
            options: { model: HAIKU_MODEL, agentId: "explore" },
          });
    expect(result).not.toMatchObject({
      success: false,
      error: { raw: TASK_ATTEMPT_SETTLED_SEND_BLOCKED_MESSAGE },
    });
    expect(result.success).toBe(true);
    const recoveredAttemptId = findWorkspace(env, childId)?.taskAttemptId;
    expect(recoveredAttemptId).toMatch(/^att_[0-9a-f]{16}$/);
    expect(recoveredAttemptId).not.toBe(reactivationAttemptId);
    if (predecessorStatus === "reported") {
      expect(findWorkspace(env, childId)).toMatchObject({ taskStatus: "reported", reportedAt });
    }
    // The recovered turn runs to completion under the fresh attempt.
    expect(
      await waitFor(
        () =>
          !testEnv.services.aiService.isStreaming(childId) &&
          !testEnv.services.workspaceService.getOrCreateSession(childId).isBusy(),
        15_000
      )
    ).toBe(true);
  }

  test.each([
    ["interrupted", "sendMessage"],
    ["interrupted", "resumeStream"],
  ] as const)(
    "a parent Stop cascade over a reactivated %s child leaves it manually recoverable via %s under a fresh attempt",
    recoverManuallyAfterCascade,
    40_000
  );

  test.each([
    ["reported", "sendMessage"],
    ["reported", "resumeStream"],
  ] as const)(
    "a parent Stop cascade over a reactivated %s child leaves it manually recoverable via %s under a fresh attempt",
    recoverManuallyAfterCascade,
    40_000
  );

  test("reawakens a compacted child in place and settles its continuation without a live LLM", async () => {
    if (!env || !repoPath) throw new Error("Test environment not initialized");

    const parentResult = await createWorkspace(
      env,
      repoPath,
      generateBranchName("persistent-compaction-parent")
    );
    if (!parentResult.success) throw new Error(parentResult.error);
    workspaceIds.push(parentResult.metadata.id);

    const childResult = await createWorkspace(
      env,
      repoPath,
      generateBranchName("persistent-compaction-child")
    );
    if (!childResult.success) throw new Error(childResult.error);
    workspaceIds.push(childResult.metadata.id);

    const parentWorkspaceId = parentResult.metadata.id;
    const childWorkspaceId = childResult.metadata.id;
    const historyService = new HistoryService(env.config);
    const seedText = "Original specialist context that should stay behind the boundary";

    const seedResult = await sendMessageWithModel(env, childWorkspaceId, seedText, HAIKU_MODEL, {
      agentId: "explore",
    });
    expect(seedResult.success).toBe(true);
    const seedCompleted = await waitFor(async () => {
      const history = await historyService.getLastMessages(childWorkspaceId, 20);
      return (
        history.success &&
        history.data.some(
          (message) => message.role === "assistant" && extractText(message).includes(seedText)
        )
      );
    }, 10_000);
    if (!seedCompleted) {
      const history = await historyService.getLastMessages(childWorkspaceId, 20);
      throw new Error(`Seed turn did not complete: ${JSON.stringify(history)}`);
    }

    const compactResult = await sendMessageWithModel(
      env,
      childWorkspaceId,
      "Summarize the conversation into a compact form.",
      HAIKU_MODEL,
      {
        agentId: "compact",
        muxMetadata: {
          type: "compaction-request",
          rawCommand: "/compact -t 500",
          parsed: { maxOutputTokens: 500 },
        },
      }
    );
    expect(compactResult.success).toBe(true);
    const compactionCompleted = await waitFor(async () => {
      const history = await historyService.getHistoryFromLatestBoundary(childWorkspaceId);
      return history.success && history.data[0]?.metadata?.compactionBoundary === true;
    }, 10_000);
    if (!compactionCompleted) {
      const history = await historyService.getLastMessages(childWorkspaceId, 20);
      throw new Error(`Compaction did not complete: ${JSON.stringify(history)}`);
    }

    const reportedAt = "2026-08-10T12:00:00.000Z";
    await env.config.addWorkspace(repoPath, {
      ...childResult.metadata,
      parentWorkspaceId,
      agentId: "explore",
      agentType: "explore",
      taskStatus: "reported",
      reportedAt,
      taskModelString: HAIKU_MODEL,
      title: "Compaction specialist",
    });

    const reactivated = await env.services.taskService.sendMessageToDescendantAgentTask(
      parentWorkspaceId,
      childWorkspaceId,
      "Inspect the regression using the compacted context.",
      "tool-end"
    );
    expect(reactivated.success).toBe(true);
    if (!reactivated.success || reactivated.data.delivery !== "reactivated") {
      throw new Error("Expected the persistent child to reactivate");
    }
    const executionTaskId = reactivated.data.executionTaskId;
    if (!executionTaskId) throw new Error("Expected a reactivated execution task ID");

    const continuation = await env.services.workspaceTurnManager.waitForWorkspaceTurn(
      executionTaskId,
      {
        requestingWorkspaceId: parentWorkspaceId,
        ownerWorkspaceId: parentWorkspaceId,
        backgroundOnMessageQueued: false,
        timeoutMs: 10_000,
      }
    );
    expect(continuation).toMatchObject({
      taskId: executionTaskId,
      workspaceId: childWorkspaceId,
      reportMarkdown: expect.stringContaining(
        "Inspect the regression using the compacted context."
      ),
    });

    const child = findWorkspace(env, childWorkspaceId);
    expect(child).toMatchObject({
      parentWorkspaceId,
      taskStatus: "reported",
      reportedAt,
      taskExecutionId: executionTaskId,
      taskExecutionStatus: "completed",
    });

    const activeHistory = await historyService.getHistoryFromLatestBoundary(childWorkspaceId);
    expect(activeHistory.success).toBe(true);
    if (!activeHistory.success) throw new Error(activeHistory.error);
    expect(activeHistory.data[0]?.metadata?.compactionBoundary).toBe(true);
    expect(activeHistory.data.some((message) => extractText(message).includes(seedText))).toBe(
      false
    );
    expect(
      activeHistory.data.some((message) =>
        extractText(message).includes("Inspect the regression using the compacted context.")
      )
    ).toBe(true);

    const fullHistory: MuxMessage[] = [];
    const fullHistoryResult = await historyService.iterateFullHistory(
      childWorkspaceId,
      "forward",
      (messages) => {
        fullHistory.push(...messages);
      }
    );
    expect(fullHistoryResult.success).toBe(true);
    expect(fullHistory.some((message) => extractText(message).includes(seedText))).toBe(true);

    const lastPrompt =
      env.services.aiService.mockAiStreamPlayer?.debugGetLastPrompt(childWorkspaceId);
    if (lastPrompt == null) throw new Error("Expected a captured mock prompt");
    expect(lastPrompt[0]?.metadata?.compactionBoundary).toBe(true);
    expect(lastPrompt.some((message) => extractText(message).includes(seedText))).toBe(false);
  }, 30_000);
});
