import { describe, expect, test, mock, beforeEach, afterEach, spyOn } from "bun:test";
import type { WorkspaceService } from "./workspaceService";
import type { AgentSession } from "./agentSession";
import { createAgentSessionHarness } from "./agentSession.testHarness";
import path from "path";
import { Ok } from "@/common/types/result";
import { createTestHistoryService } from "./testHistoryService";
import { projectWorkspace, saveWorkspaces } from "./taskService.testHarness";
import type { AIService } from "./aiService";
import { createMuxMessage } from "@/common/types/message";
import {
  buildPlanReviewMetadata,
  formatPlanReviewEnvelope,
} from "@/common/utils/planReview/planReviewEnvelope";
import type { PlanReviewRecord } from "@/common/utils/planReview/planReviewRecord";
import type { WorkspaceServiceHarness } from "./workspaceService.testHarness";
import {
  addToRenamingWorkspaces,
  createWorkspaceServiceForTest,
  createWorkspaceServiceHarness,
} from "./workspaceService.testHarness";

describe("WorkspaceService rename lock", () => {
  let harness: WorkspaceServiceHarness;
  let workspaceService: WorkspaceService;

  beforeEach(async () => {
    harness = await createWorkspaceServiceHarness();
    workspaceService = harness.service;
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  test("sendMessage returns error when workspace is being renamed", async () => {
    const workspaceId = "test-workspace";

    addToRenamingWorkspaces(workspaceService, workspaceId);

    const result = await workspaceService.sendMessage(workspaceId, "test message", {
      model: "test-model",
      agentId: "exec",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const error = result.error;
      // Error is SendMessageError which has a discriminated union
      expect(typeof error === "object" && error.type === "unknown").toBe(true);
      if (typeof error === "object" && error.type === "unknown") {
        expect(error.raw).toContain("being renamed");
      }
    }
  });

  test("resumeStream returns error when workspace is being renamed", async () => {
    const workspaceId = "test-workspace";

    addToRenamingWorkspaces(workspaceService, workspaceId);

    const result = await workspaceService.resumeStream(workspaceId, {
      model: "test-model",
      agentId: "exec",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const error = result.error;
      // Error is SendMessageError which has a discriminated union
      expect(typeof error === "object" && error.type === "unknown").toBe(true);
      if (typeof error === "object" && error.type === "unknown") {
        expect(error.raw).toContain("being renamed");
      }
    }
  });

  test("rename returns error when workspace is streaming", async () => {
    const workspaceId = "test-workspace";

    spyOn(harness.aiService, "isStreaming").mockReturnValue(true);

    const result = await workspaceService.rename(workspaceId, "new-name");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("stream is active");
    }
  });

  test("an SSH rename is serialized through the workspace's MCP-overrides lock", async () => {
    // A settings save that passed its revision check on the old checkout path
    // must not write into a recreated old path after the remote move: every
    // runtime's rename holds THIS workspace's writer lock across move + config
    // rewrite (scoped, so unrelated workspaces' saves are not blocked).
    const workspaceId = "ssh-workspace";
    await harness.config.addWorkspace("/tmp/project", {
      id: workspaceId,
      name: "old-name",
      projectPath: "/tmp/project",
      projectName: "project",
      runtimeConfig: { type: "ssh", host: "example.invalid", srcBaseDir: "/srv" },
      namedWorkspacePath: "/srv/project/old-name",
    });
    const acquireWorkspaceLock = mock((_workspaceId: string) =>
      Promise.reject(new Error("Another Mux process is currently updating workspace MCP settings"))
    );
    workspaceService.setWorkspaceMcpOverridesService({
      acquireWorkspaceLock,
      prunePluginOverrideKeys: () => Promise.resolve(),
      copyOverridesToForkedCheckout: () => Promise.resolve(),
    });

    const result = await workspaceService.rename(workspaceId, "new-name");

    // The lock is taken BEFORE any remote move; its failure fails the rename.
    expect(acquireWorkspaceLock).toHaveBeenCalledTimes(1);
    expect(acquireWorkspaceLock).toHaveBeenCalledWith(workspaceId);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("updating workspace MCP settings");
    }
  });
});

test.each([
  { source: "partial", live: false },
  { source: "history", live: true },
])(
  "restored question guidance queues without dispatch and dedupes live sends (%j)",
  async ({ source, live }) => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "restored-question";
    const projectPath = path.join(config.rootDir, "repo");
    await saveWorkspaces(config, projectPath, [
      projectWorkspace(projectPath, "child", workspaceId),
    ]);
    const { session, aiService } = await createAgentSessionHarness({
      workspaceId,
      config,
      historyService,
    });
    const workspaceService = createWorkspaceServiceForTest({
      config,
      historyService,
      aiService: aiService as unknown as AIService,
    });
    (workspaceService as unknown as { sessions: Map<string, AgentSession> }).sessions.set(
      workspaceId,
      session
    );
    const question = createMuxMessage("question", "assistant", "", {}, [
      {
        type: "dynamic-tool",
        state: "input-available",
        toolCallId: "ask-restored",
        toolName: "ask_user_question",
        input: {
          questions: [
            {
              header: "Choice",
              question: "Which option?",
              options: [
                { label: "First", description: "Use first" },
                { label: "Second", description: "Use second" },
              ],
              multiSelect: false,
            },
          ],
        },
      },
    ]);
    await historyService.appendToHistory(workspaceId, createMuxMessage("user", "user", "Work"));
    if (source === "partial") await historyService.writePartial(workspaceId, question);
    else await historyService.appendToHistory(workspaceId, question);
    const queue = spyOn(session, "queueMessage");
    const send = spyOn(session, "sendMessage");
    const drain = spyOn(session, "drainQueuedMessagesIfIdle");
    const busy = spyOn(session, "isBusy").mockReturnValue(live);
    const accepted = mock(() => undefined);
    const internal = {
      synthetic: true,
      agentInitiated: true,
      queueDedupeKey: "durable-guidance",
      onAccepted: accepted,
    };
    const options = {
      model: "openai:gpt-5.2",
      agentId: "exec",
      queueDispatchMode: "turn-end" as const,
    };
    try {
      expect(
        await workspaceService.sendMessage(workspaceId, "Correction", options, {
          ...internal,
          restoreQueued: !live,
        })
      ).toEqual(Ok(undefined));
      if (!live) expect(drain).not.toHaveBeenCalled();
      busy.mockReturnValue(false);
      const drainsBeforeRestore = drain.mock.calls.length;
      for (const restoreQueued of [true, true, false]) {
        expect(
          await workspaceService.sendMessage(workspaceId, "Correction", options, {
            ...internal,
            restoreQueued,
          })
        ).toEqual(Ok(undefined));
      }
      expect(queue).toHaveBeenCalledTimes(1);
      expect(queue.mock.calls[0]?.[1]?.queueDispatchMode).toBe("turn-end");
      expect(drain).toHaveBeenCalledTimes(drainsBeforeRestore);
      expect(send).not.toHaveBeenCalled();
      expect(accepted).not.toHaveBeenCalled();
      const readQuestion = async () => {
        if (source === "partial") return historyService.readPartial(workspaceId);
        const history = await historyService.getLastMessages(workspaceId, 1);
        expect(history.success).toBe(true);
        return history.success ? history.data[0] : undefined;
      };
      expect((await readQuestion())?.parts[0]).toMatchObject({ state: "input-available" });
      expect(
        await workspaceService.answerAskUserQuestion(workspaceId, "ask-restored", {
          "Which option?": "First",
        })
      ).toEqual(Ok(undefined));
      expect((await readQuestion())?.parts[0]).toMatchObject({ state: "output-available" });
      expect(session.hasQueuedDedupeKey(internal.queueDedupeKey)).toBe(true);
      expect(accepted).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    } finally {
      busy.mockRestore();
      await session.dispose();
      await cleanup();
    }
  }
);

test("a committed question stays answerable after a hidden plan-review record is appended", async () => {
  // Resolving a review thread appends a model-hidden row with a higher sequence than the
  // committed question. That row is UI state, not a conversational turn, so the staleness
  // guard must not treat the still-current question as superseded.
  const { config, historyService, cleanup } = await createTestHistoryService();
  const workspaceId = "question-then-review-record";
  const projectPath = path.join(config.rootDir, "repo");
  await saveWorkspaces(config, projectPath, [projectWorkspace(projectPath, "child", workspaceId)]);
  const { session, aiService } = await createAgentSessionHarness({
    workspaceId,
    config,
    historyService,
  });
  const workspaceService = createWorkspaceServiceForTest({
    config,
    historyService,
    aiService: aiService as unknown as AIService,
  });
  (workspaceService as unknown as { sessions: Map<string, AgentSession> }).sessions.set(
    workspaceId,
    session
  );
  const question = createMuxMessage("question", "assistant", "", {}, [
    {
      type: "dynamic-tool",
      state: "input-available",
      toolCallId: "ask-then-resolve",
      toolName: "ask_user_question",
      input: {
        questions: [
          {
            header: "Choice",
            question: "Which option?",
            options: [
              { label: "First", description: "Use first" },
              { label: "Second", description: "Use second" },
            ],
            multiSelect: false,
          },
        ],
      },
    },
  ]);
  const resolveRecord: PlanReviewRecord = {
    v: 1,
    kind: "resolve",
    recordId: "rec_after_question",
    threadId: "thr_after_question",
  };
  try {
    await historyService.appendToHistory(workspaceId, createMuxMessage("user", "user", "Work"));
    await historyService.appendToHistory(workspaceId, question);
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("resolve-row", "user", formatPlanReviewEnvelope(resolveRecord), {
        synthetic: true,
        muxMetadata: buildPlanReviewMetadata(resolveRecord),
      })
    );
    expect(
      await workspaceService.answerAskUserQuestion(workspaceId, "ask-then-resolve", {
        "Which option?": "First",
      })
    ).toEqual(Ok(undefined));
    const history = await historyService.getLastMessages(workspaceId, 2);
    expect(history.success).toBe(true);
    if (history.success) {
      expect(history.data.find((m) => m.id === "question")?.parts[0]).toMatchObject({
        state: "output-available",
      });
    }
  } finally {
    await session.dispose();
    await cleanup();
  }
});
