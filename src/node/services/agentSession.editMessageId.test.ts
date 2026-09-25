import { describe, expect, it, mock, afterEach, spyOn } from "bun:test";
import type { AIService, StreamMessageOptions } from "@/node/services/aiService";
import {
  createMuxMessage,
  getCompactionFollowUpContent,
  type MuxMessageMetadata,
} from "@/common/types/message";
import { Err, Ok } from "@/common/types/result";
import type { HistoryService } from "./historyService";
import { getPlanReviewState, hashPlanSnapshotContent } from "./planReviewService";
import type { PlanReviewRecord } from "@/common/utils/planReview/planReviewRecord";
import {
  buildPlanReviewMetadata,
  formatPlanReviewEnvelope,
} from "@/common/utils/planReview/planReviewEnvelope";
import { PLAN_REVIEW_FEEDBACK_EDIT_BLOCKED_MESSAGE } from "./agentSession";
import { createAgentSessionHarness, createStartedTurnHandle } from "./agentSession.testHarness";

type StreamMessageHandler = AIService["streamMessage"];

const TEST_MODEL = "anthropic:claude-3-5-sonnet-latest";

async function waitForCondition(condition: () => boolean, timeoutMs = 1000): Promise<boolean> {
  if (condition()) {
    return true;
  }
  if (timeoutMs <= 0) {
    return false;
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
  return waitForCondition(condition, timeoutMs - 10);
}

describe("AgentSession.sendMessage (editMessageId)", () => {
  let historyCleanup: (() => Promise<void>) | undefined;

  async function createSessionHarness(
    workspaceId: string,
    streamHandler: StreamMessageHandler = (opts: StreamMessageOptions) =>
      Promise.resolve(Ok(createStartedTurnHandle(opts.abortSignal!)))
  ) {
    const streamMessage = mock(streamHandler);
    const harness = await createAgentSessionHarness({
      workspaceId,
      aiServiceOverrides: {
        streamMessage: streamMessage as unknown as AIService["streamMessage"],
      },
    });
    historyCleanup = harness.cleanup;
    return { historyService: harness.historyService, streamMessage, session: harness.session };
  }

  async function seedImageMessage(
    workspaceId: string,
    historyService: HistoryService,
    messageId = "user-message-with-image"
  ): Promise<string> {
    const originalImageUrl = "data:image/png;base64,AAAA";
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage(messageId, "user", "original", { historySequence: 0 }, [
        { type: "file", mediaType: "image/png", url: originalImageUrl },
      ])
    );
    return originalImageUrl;
  }

  afterEach(async () => {
    await historyCleanup?.();
  });

  it("treats missing edit target as no-op (allows recovery after compaction)", async () => {
    const { session, historyService, streamMessage } = await createSessionHarness("ws-test");
    const truncateAfterMessage = spyOn(historyService, "truncateAfterMessage");
    const acceptance = spyOn(historyService, "acceptCompactionReplacement");

    const result = await session.sendMessage("hello", {
      model: TEST_MODEL,
      agentId: "exec",
      editMessageId: "missing-user-message-id",
    });

    expect(result.success).toBe(true);
    expect(truncateAfterMessage.mock.calls).toHaveLength(1);
    expect(acceptance.mock.calls).toHaveLength(1);

    await session.waitForIdle();
    expect(streamMessage.mock.calls).toHaveLength(1);
  });

  it("passes muxMetadata through to the stream request", async () => {
    const { session, streamMessage } = await createSessionHarness("ws-mux-metadata");
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: "owner-workspace",
      turnId: "turn-id",
    };

    const result = await session.sendMessage("hello", {
      model: TEST_MODEL,
      agentId: "exec",
      muxMetadata,
    });

    expect(result.success).toBe(true);
    expect(streamMessage).toHaveBeenCalledTimes(1);
    expect(streamMessage.mock.calls[0]?.[0]).toMatchObject({ muxMetadata });
  });

  it("does not truncate history when edit validation fails", async () => {
    const workspaceId = "ws-edit-validation";
    const { session, historyService, streamMessage } = await createSessionHarness(workspaceId);
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-original", "user", "original", { historySequence: 0 })
    );
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("assistant-original", "assistant", "reply", { historySequence: 1 })
    );
    const truncateAfterMessage = spyOn(historyService, "truncateAfterMessage");
    const acceptance = spyOn(historyService, "acceptCompactionReplacement");

    const result = await session.sendMessage("edited", {
      model: "invalid-model",
      agentId: "exec",
      editMessageId: "user-original",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.type).toBe("invalid_model_string");
    }
    expect(truncateAfterMessage).not.toHaveBeenCalled();
    expect(acceptance).not.toHaveBeenCalled();
    expect(streamMessage).not.toHaveBeenCalled();

    const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
    expect(history.success).toBe(true);
    if (history.success) {
      expect(history.data.map((message) => message.id)).toEqual([
        "user-original",
        "assistant-original",
      ]);
    }
  });

  it("refuses a direct edit of authentic plan-review feedback before touching history", async () => {
    // An ordinary edit would resend only the envelope text, which is neutralized as an untrusted
    // lookalike, so the threads this feedback opened would silently vanish from review state.
    const workspaceId = "ws-edit-plan-feedback";
    const { session, historyService, streamMessage } = await createSessionHarness(workspaceId);
    const feedbackRecord: PlanReviewRecord = {
      v: 1,
      kind: "feedback",
      recordId: "rec-f",
      feedbackId: "f1",
      snapshotId: "s1",
      contentHash: "a".repeat(64),
      comments: [{ threadId: "t1", anchor: { startLine: 1, endLine: 1 }, quote: "#", body: "?" }],
      replies: [],
    };
    const envelope = formatPlanReviewEnvelope(feedbackRecord);
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("plan-feedback", "user", envelope, {
        historySequence: 0,
        muxMetadata: buildPlanReviewMetadata(feedbackRecord),
      })
    );
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("assistant-reply", "assistant", "Revised the plan", { historySequence: 1 })
    );
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-ordinary", "user", "Also cover rollback", { historySequence: 2 })
    );
    const truncateAfterMessage = spyOn(historyService, "truncateAfterMessage");
    const ids = async () => {
      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(history.success).toBe(true);
      return history.success ? history.data.map((message) => message.id) : [];
    };

    const refused = await session.sendMessage("edited feedback", {
      model: TEST_MODEL,
      agentId: "exec",
      editMessageId: "plan-feedback",
    });

    expect(refused.success).toBe(false);
    if (!refused.success) {
      expect(refused.error).toMatchObject({
        type: "unknown",
        raw: PLAN_REVIEW_FEEDBACK_EDIT_BLOCKED_MESSAGE,
      });
    }
    expect(truncateAfterMessage).not.toHaveBeenCalled();
    expect(streamMessage).not.toHaveBeenCalled();
    expect(await ids()).toEqual(["plan-feedback", "assistant-reply", "user-ordinary"]);

    // Control: ordinary messages after the feedback stay editable.
    const edited = await session.sendMessage("Also cover rollback and retries", {
      model: TEST_MODEL,
      agentId: "exec",
      editMessageId: "user-ordinary",
    });
    expect(edited.success).toBe(true);
    await session.waitForIdle();
    expect(streamMessage).toHaveBeenCalledTimes(1);
    expect((await ids()).slice(0, 2)).toEqual(["plan-feedback", "assistant-reply"]);
  });

  it("refuses an edit of a compaction request whose follow-up carries plan-review feedback", async () => {
    // On-send compaction defers feedback as the request's nested follow-up; that follow-up
    // dispatches as the feedback row later. Editing the request would truncate it and drop the
    // feedback (and its threads) exactly as editing the feedback row itself would.
    const workspaceId = "ws-edit-compaction-feedback";
    const { session, historyService, streamMessage } = await createSessionHarness(workspaceId);
    const feedbackRecord: PlanReviewRecord = {
      v: 1,
      kind: "feedback",
      recordId: "rec-f",
      feedbackId: "f1",
      snapshotId: "s1",
      contentHash: "a".repeat(64),
      comments: [{ threadId: "t1", anchor: { startLine: 1, endLine: 1 }, quote: "#", body: "?" }],
      replies: [],
    };
    const compactionRequest = (followUpText: string, followUpMetadata?: MuxMessageMetadata) =>
      ({
        type: "compaction-request",
        rawCommand: "/compact",
        source: "auto-compaction",
        parsed: {
          followUpContent: {
            text: followUpText,
            model: TEST_MODEL,
            agentId: "plan",
            ...(followUpMetadata ? { muxMetadata: followUpMetadata } : {}),
          },
        },
      }) satisfies MuxMessageMetadata;
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("compaction-feedback", "user", "Summarize the conversation", {
        historySequence: 0,
        muxMetadata: compactionRequest(
          formatPlanReviewEnvelope(feedbackRecord),
          buildPlanReviewMetadata(feedbackRecord)
        ),
      })
    );
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("compaction-ordinary", "user", "Summarize the conversation", {
        historySequence: 1,
        muxMetadata: compactionRequest("Also cover rollback"),
      })
    );
    const truncateAfterMessage = spyOn(historyService, "truncateAfterMessage");
    const ids = async () => {
      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(history.success).toBe(true);
      return history.success ? history.data.map((message) => message.id) : [];
    };

    const refused = await session.sendMessage("edited", {
      model: TEST_MODEL,
      agentId: "exec",
      editMessageId: "compaction-feedback",
    });

    expect(refused.success).toBe(false);
    if (!refused.success) {
      expect(refused.error).toMatchObject({
        type: "unknown",
        raw: PLAN_REVIEW_FEEDBACK_EDIT_BLOCKED_MESSAGE,
      });
    }
    expect(truncateAfterMessage).not.toHaveBeenCalled();
    expect(streamMessage).not.toHaveBeenCalled();
    expect(await ids()).toEqual(["compaction-feedback", "compaction-ordinary"]);
    // The deferred handoff still carries the feedback.
    const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
    expect(history.success).toBe(true);
    if (!history.success) return;
    expect(
      getCompactionFollowUpContent(history.data[0]?.metadata?.muxMetadata)?.muxMetadata
    ).toEqual(buildPlanReviewMetadata(feedbackRecord));

    // Control: a compaction request with an ordinary follow-up stays editable.
    const edited = await session.sendMessage("Also cover retries", {
      model: TEST_MODEL,
      agentId: "exec",
      editMessageId: "compaction-ordinary",
    });
    expect(edited.success).toBe(true);
    await session.waitForIdle();
    expect(streamMessage).toHaveBeenCalledTimes(1);
    expect((await ids())[0]).toBe("compaction-feedback");
    expect(await ids()).not.toContain("compaction-ordinary");
  });

  it("refuses an edit when the full-history read that classifies an archived target fails", async () => {
    // A compaction boundary archives the feedback row, so only the full-history scan can see
    // it. If that read fails, the edit must not proceed: a later successful read would truncate
    // the authentic feedback and replace it with a neutralized plain-text wrapper, deleting its
    // threads from review state.
    const workspaceId = "ws-edit-plan-feedback-read-failure";
    const { session, historyService, streamMessage } = await createSessionHarness(workspaceId);
    const planContent = "# Plan\n\nStep one.\n";
    const snapshotRecord: PlanReviewRecord = {
      v: 1,
      kind: "snapshot",
      recordId: "rec-s",
      snapshotId: "s1",
      planPath: "/tmp/plan.md",
      contentHash: hashPlanSnapshotContent(planContent),
      content: planContent,
    };
    const feedbackRecord: PlanReviewRecord = {
      v: 1,
      kind: "feedback",
      recordId: "rec-f",
      feedbackId: "f1",
      snapshotId: "s1",
      contentHash: snapshotRecord.contentHash,
      comments: [{ threadId: "t1", anchor: { startLine: 1, endLine: 1 }, quote: "#", body: "?" }],
      replies: [],
    };
    for (const [id, record] of [
      ["plan-snapshot", snapshotRecord],
      ["plan-feedback", feedbackRecord],
    ] as const) {
      const appended = await historyService.appendToHistory(
        workspaceId,
        createMuxMessage(id, "user", formatPlanReviewEnvelope(record), {
          synthetic: record.kind === "snapshot",
          muxMetadata: buildPlanReviewMetadata(record),
        })
      );
      expect(appended.success).toBe(true);
    }
    const compacted = await historyService.persistBoundaryWithTailCopies(
      workspaceId,
      createMuxMessage("summary", "assistant", "summary", {
        compacted: "user",
        compactionBoundary: true,
        compactionEpoch: 1,
      }),
      [],
      false
    );
    expect(compacted.success).toBe(true);
    const latest = await historyService.getHistoryFromLatestBoundary(workspaceId);
    expect(latest.success && latest.data.map((message) => message.id)).toEqual(["summary"]);

    spyOn(historyService, "iterateFullHistory").mockResolvedValueOnce(Err("disk read failed"));
    const refused = await session.sendMessage("edited feedback", {
      model: TEST_MODEL,
      agentId: "exec",
      editMessageId: "plan-feedback",
    });

    expect(refused.success).toBe(false);
    if (!refused.success) {
      expect(refused.error.type).toBe("unknown");
      expect(refused.error.type === "unknown" && refused.error.raw).toContain("disk read failed");
    }
    expect(streamMessage).not.toHaveBeenCalled();
    const state = await getPlanReviewState(historyService, workspaceId);
    expect(state.success).toBe(true);
    if (state.success) {
      expect(state.data.feedbacks.map((feedback) => feedback.feedbackId)).toEqual(["f1"]);
      expect(state.data.threads.map((thread) => thread.threadId)).toEqual(["t1"]);
    }
  });

  it("clears image parts when editing with explicit empty fileParts", async () => {
    const workspaceId = "ws-test";
    const { session, historyService } = await createSessionHarness(workspaceId);
    const originalMessageId = "user-message-with-image";
    await seedImageMessage(workspaceId, historyService, originalMessageId);
    const truncateAfterMessage = spyOn(historyService, "truncateAfterMessage");
    const acceptance = spyOn(historyService, "acceptCompactionReplacement");

    const result = await session.sendMessage("edited", {
      model: TEST_MODEL,
      agentId: "exec",
      editMessageId: originalMessageId,
      fileParts: [],
    });

    expect(result.success).toBe(true);
    expect(truncateAfterMessage.mock.calls).toHaveLength(1);
    expect(acceptance.mock.calls).toHaveLength(1);

    const persisted = await historyService.getLastMessages(workspaceId, 1);
    if (!persisted.success) throw new Error(persisted.error);
    const appendedMessage = persisted.data[0];
    const appendedFileParts = appendedMessage.parts.filter(
      (part) => part.type === "file"
    ) as Array<{ type: "file"; url: string; mediaType: string }>;

    expect(appendedFileParts).toHaveLength(0);
  });

  it("preserves image parts when editing and fileParts are omitted", async () => {
    const workspaceId = "ws-test";
    const { session, historyService } = await createSessionHarness(workspaceId);
    const originalMessageId = "user-message-with-image";
    const originalImageUrl = await seedImageMessage(workspaceId, historyService, originalMessageId);
    const truncateAfterMessage = spyOn(historyService, "truncateAfterMessage");
    const acceptance = spyOn(historyService, "acceptCompactionReplacement");
    const result = await session.sendMessage("edited", {
      model: TEST_MODEL,
      agentId: "exec",
      editMessageId: originalMessageId,
    });

    expect(result.success).toBe(true);
    expect(truncateAfterMessage.mock.calls).toHaveLength(1);
    expect(acceptance.mock.calls).toHaveLength(1);

    const persisted = await historyService.getLastMessages(workspaceId, 1);
    if (!persisted.success) throw new Error(persisted.error);
    const appendedMessage = persisted.data[0];
    const appendedFileParts = appendedMessage.parts.filter(
      (part) => part.type === "file"
    ) as Array<{ type: "file"; url: string; mediaType: string }>;

    expect(appendedFileParts).toHaveLength(1);
    expect(appendedFileParts[0].url).toBe(originalImageUrl);
    expect(appendedFileParts[0].mediaType).toBe("image/png");
  });

  it("removes snapshots when editing before the latest context boundary", async () => {
    const workspaceId = "ws-edit-before-boundary-snapshot";
    const { session, historyService } = await createSessionHarness(workspaceId);

    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("snapshot-original", "user", "snapshot", {
        historySequence: 0,
        synthetic: true,
        fileAtMentionSnapshot: ["@src/foo.ts"],
      })
    );
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-original", "user", "original @src/foo.ts", {
        historySequence: 1,
      })
    );
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("assistant-original", "assistant", "reply", { historySequence: 2 })
    );
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("boundary", "assistant", "summary", {
        historySequence: 3,
        compacted: "user",
        compactionBoundary: true,
        compactionEpoch: 1,
      })
    );
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("assistant-after-boundary", "assistant", "after", { historySequence: 4 })
    );
    const activeWindow = await historyService.getHistoryFromLatestBoundary(workspaceId);
    expect(activeWindow.success).toBe(true);
    if (activeWindow.success) {
      expect(activeWindow.data.map((message) => message.id)).toEqual([
        "boundary",
        "assistant-after-boundary",
      ]);
    }
    const truncateAfterMessage = spyOn(historyService, "truncateAfterMessage");

    const result = await session.sendMessage("edited without mention", {
      model: TEST_MODEL,
      agentId: "exec",
      editMessageId: "user-original",
    });

    expect(result.success).toBe(true);
    expect(truncateAfterMessage.mock.calls[0]?.[1]).toBe("snapshot-original");

    const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
    expect(history.success).toBe(true);
    if (history.success) {
      expect(history.data.map((message) => message.id)).not.toContain("snapshot-original");
      expect(history.data.map((message) => message.id)).toHaveLength(1);
    }
  });

  it("preempts a still-preparing turn when editing its last user message", async () => {
    const workspaceId = "ws-edit-preparing";
    const streamResolves: Array<() => void> = [];
    const streamHandler: StreamMessageHandler = (opts) => {
      return new Promise<Awaited<ReturnType<StreamMessageHandler>>>((resolve) => {
        const resolveOk = () => resolve(Ok(createStartedTurnHandle(opts.abortSignal!)));
        if (opts.abortSignal?.aborted === true) {
          resolveOk();
          return;
        }
        opts.abortSignal?.addEventListener("abort", resolveOk, { once: true });
        streamResolves.push(resolveOk);
      });
    };
    const { session, historyService, streamMessage } = await createSessionHarness(
      workspaceId,
      streamHandler
    );
    try {
      const firstSendPromise = session.sendMessage("original", {
        model: TEST_MODEL,
        agentId: "exec",
      });

      const sawPreparingTurn = await waitForCondition(
        () => streamMessage.mock.calls.length === 1 && session.isPreparingTurn()
      );
      expect(sawPreparingTurn).toBe(true);

      const persisted = await historyService.getLastMessages(workspaceId, 1);
      if (!persisted.success) throw new Error(persisted.error);
      const originalMessage = persisted.data[0];
      const originalMessageId = originalMessage?.id;
      expect(typeof originalMessageId).toBe("string");

      const editResult = await Promise.race([
        session.sendMessage("edited", {
          model: TEST_MODEL,
          agentId: "exec",
          editMessageId: originalMessageId,
        }),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 250)),
      ]);

      expect(editResult).not.toBe("timeout");
      expect(editResult).toEqual(Ok(undefined));

      const sawReplacementStartup = await waitForCondition(
        () => streamMessage.mock.calls.length === 2 && session.isPreparingTurn()
      );
      expect(sawReplacementStartup).toBe(true);

      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(history.success).toBe(true);
      if (history.success) {
        const userTexts = history.data
          .filter((message) => message.role === "user")
          .map((message) =>
            message.parts
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("")
          );
        expect(userTexts).toEqual(["edited"]);
      }

      for (const resolve of streamResolves) {
        resolve();
      }
      await firstSendPromise;
    } finally {
      session.beginDispose();
      for (const resolve of streamResolves) {
        resolve();
      }
      await session.dispose();
    }
  });

  it("holds isBusy through the edit's truncate window (r32 admission reservation)", async () => {
    // The edit path truncates history and can spend up to the branch-summary
    // deadline before its turn reaches PREPARING. Without a reservation a
    // concurrent ordinary send observes an idle session and starts
    // immediately, interleaving its rows with the edit's against moved
    // history.
    const workspaceId = "ws-edit-admission";
    const { session, historyService } = await createSessionHarness(workspaceId);
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-original", "user", "original", { historySequence: 0 })
    );

    let releaseTruncate: (() => void) | null = null;
    const truncateGate = new Promise<void>((resolve) => {
      releaseTruncate = resolve;
    });
    const observed: { busyDuringTruncate: boolean | null } = { busyDuringTruncate: null };
    const realTruncate = historyService.truncateAfterMessage.bind(historyService);
    spyOn(historyService, "truncateAfterMessage").mockImplementation(async (...args) => {
      observed.busyDuringTruncate = session.isBusy();
      await truncateGate;
      return realTruncate(...args);
    });

    const sendPromise = session.sendMessage("edited", {
      model: TEST_MODEL,
      agentId: "exec",
      editMessageId: "user-original",
    });
    await waitForCondition(() => observed.busyDuringTruncate !== null);
    // Observed both from inside the truncate window and from a concurrent
    // caller's perspective right now.
    expect(observed.busyDuringTruncate).toBe(true);
    expect(session.isBusy()).toBe(true);

    releaseTruncate!();
    const result = await sendPromise;
    expect(result.success).toBe(true);
    await session.waitForIdle();
    // The reservation released with the turn: the session is not stuck busy.
    expect(session.isBusy()).toBe(false);
  });
});
