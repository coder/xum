import { describe, expect, test, mock, afterEach, spyOn } from "bun:test";
import { EventEmitter } from "events";
import * as fsPromises from "fs/promises";
import * as path from "path";

import { POST_COMPACTION_ATTACHMENTS_MESSAGE_ID_PREFIX } from "@/common/constants/attachments";
import { Err } from "@/common/types/result";
import assert from "@/common/utils/assert";

import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import type { SendMessageOptions } from "@/common/orpc/types";
import { createTestHistoryService } from "./testHistoryService";
import { AttachmentService } from "./attachmentService";
import type { CompactionHandler } from "./compactionHandler";
import type { TurnStreamHandle } from "./turnEngine/types";
import {
  createAgentSessionHarness,
  createFailedTurnHandle,
  createStartedTurnHandle,
} from "./agentSession.testHarness";

function contextExceededResult(messageId: string) {
  return {
    success: true as const,
    data: createFailedTurnHandle(messageId, {
      error: "Context length exceeded",
      errorType: "context_exceeded",
    }),
  };
}

function createPersistedPostCompactionState(options: {
  filePath: string;
  diffs: Array<{ path: string; diff: string; truncated: boolean }>;
}): Promise<void> {
  const payload = {
    version: 1 as const,
    createdAt: Date.now(),
    diffs: options.diffs,
  };

  return fsPromises.writeFile(options.filePath, JSON.stringify(payload));
}

/** Publish a continuous compaction boundary for a window that edited `/<id>.ts`. */
async function publishEditWindow(
  h: Awaited<ReturnType<typeof createAgentSessionHarness>>,
  workspaceId: string,
  id: string,
  model: string
): Promise<void> {
  const handler = (
    h.session as unknown as { contextController: { compactionHandler: CompactionHandler } }
  ).contextController.compactionHandler;
  const edit = createMuxMessage(id, "assistant", "");
  edit.parts = [
    {
      type: "dynamic-tool",
      toolCallId: id,
      toolName: "file_edit_replace_string",
      state: "output-available",
      input: { path: `/${id}.ts` },
      output: { success: true, diff: `change ${id}` },
    },
  ];
  const published = await handler.persistContinuousCompaction({
    preparation: handler.beginPreparation(() => true),
    publication: {
      generation: await h.historyService
        .getContinuousCompactionJournal(workspaceId)
        .captureGeneration(),
    },
    attachmentMessages: [edit],
    messages: [edit],
    boundaryMessageId: id,
    text: `${id} summary`,
    model,
    tail: [],
    systemMessageTokens: 0,
    attachmentTokens: 0,
    shouldPersist: () => true,
  });
  expect(published).toBe(true);
}

describe("AgentSession post-compaction context retry", () => {
  let historyCleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await historyCleanup?.();
  });

  /** Real Config/HistoryService pair plus this workspace's session dir. */
  async function createSessionsFixture(workspaceId: string) {
    const { historyService, config, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;
    const sessionDir = path.join(config.sessionsDir, workspaceId);
    await fsPromises.mkdir(sessionDir, { recursive: true });
    return { historyService, config, sessionDir };
  }

  test("retries once without post-compaction injection on context_exceeded", async () => {
    const workspaceId = "ws";
    const { historyService, config, sessionDir } = await createSessionsFixture(workspaceId);
    const postCompactionPath = path.join(sessionDir, "post-compaction.json");

    await createPersistedPostCompactionState({
      filePath: postCompactionPath,
      diffs: [
        {
          path: "/tmp/foo.ts",
          diff: "@@ -1 +1 @@\n-foo\n+bar\n",
          truncated: false,
        },
      ],
    });

    const history: MuxMessage[] = [
      {
        id: "compaction-summary",
        role: "assistant",
        parts: [{ type: "text", text: "Summary" }],
        metadata: { timestamp: 1000, compacted: "user" },
      },
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Continue" }],
        metadata: { timestamp: 1100 },
      },
    ];

    for (const msg of history) {
      await historyService.appendToHistory(workspaceId, msg);
    }
    spyOn(historyService, "deleteMessage");

    const aiEmitter = new EventEmitter();

    let resolveSecondCall: (() => void) | undefined;
    const secondCall = new Promise<void>((resolve) => {
      resolveSecondCall = resolve;
    });

    let callCount = 0;
    const streamMessage = mock((..._args: unknown[]) => {
      callCount += 1;

      if (callCount === 1) {
        // Simulate a provider context limit error before any deltas.
        aiEmitter.emit("error", {
          workspaceId,
          messageId: "assistant-ctx-exceeded",
          error: "Context length exceeded",
          errorType: "context_exceeded",
        });

        return Promise.resolve(contextExceededResult("assistant-ctx-exceeded"));
      }

      resolveSecondCall?.();
      return Promise.resolve({
        success: true as const,
        data: createStartedTurnHandle(session.closingSignal, "assistant-retry"),
      });
    });

    const { session } = await createAgentSessionHarness({
      workspaceId,
      config,
      historyService,
      aiEmitter,
      aiServiceOverrides: {
        streamMessage,
        // No workspace metadata: the retry path must not depend on a runtime.
        getWorkspaceMetadata: mock(() => Promise.resolve(Err("nope"))),
      },
    });

    const options: SendMessageOptions = {
      model: "openai:gpt-4o",
      agentId: "exec",
    } as unknown as SendMessageOptions;

    // Exercise the public resume facade so retry preparation has a real admitted owner.
    await session.resumeStream(options);

    // Wait for the retry call to happen.
    await Promise.race([
      secondCall,
      new Promise((_, reject) => setTimeout(() => reject(new Error("retry timeout")), 1000)),
    ]);

    expect(streamMessage).toHaveBeenCalledTimes(2);

    // Codex fast-retry scenario: a waiter that arrives only after the retry
    // already started (and possibly finished) must still see the recorded
    // "retry-started" outcome for this attempt instead of sampling live flags.
    expect(await session.waitForPendingStreamErrorRecoveryDecision("assistant-ctx-exceeded")).toBe(
      "retry-started"
    );

    // The first request carried the durable attachments row; the retry runs without it.
    const hasAttachmentsRow = (messages: MuxMessage[]) =>
      messages.some((message) =>
        message.id.startsWith(POST_COMPACTION_ATTACHMENTS_MESSAGE_ID_PREFIX)
      );
    const requestMessages = (call: number) =>
      ((streamMessage as ReturnType<typeof mock>).mock.calls[call][0] as { messages: MuxMessage[] })
        .messages;
    expect(hasAttachmentsRow(requestMessages(0))).toBe(true);
    expect(hasAttachmentsRow(requestMessages(1))).toBe(false);
    const historyAfterRetry = await historyService.getHistoryFromLatestBoundary(workspaceId);
    expect(historyAfterRetry.success && hasAttachmentsRow(historyAfterRetry.data)).toBe(false);

    expect((historyService.deleteMessage as ReturnType<typeof mock>).mock.calls[0][1]).toBe(
      "assistant-ctx-exceeded"
    );

    // Pending post-compaction state should be discarded.
    let exists = true;
    try {
      await fsPromises.stat(postCompactionPath);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);

    await session.dispose();
  });

  // The retry must not discard the snapshot while its row stays in history: no later turn
  // could then find the row to reuse or delete, and every request would carry it.
  test("a failed row delete keeps the pending snapshot and skips the retry", async () => {
    const workspaceId = "ws-delete-fails";
    const { historyService, config, sessionDir } = await createSessionsFixture(workspaceId);
    const postCompactionPath = path.join(sessionDir, "post-compaction.json");
    await createPersistedPostCompactionState({
      filePath: postCompactionPath,
      diffs: [{ path: "/tmp/foo.ts", diff: "@@ -1 +1 @@\n-foo\n+bar\n", truncated: false }],
    });
    await historyService.appendToHistory(workspaceId, {
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "Continue" }],
      metadata: { timestamp: 1100 },
    });
    const isRow = (id: string) => id.startsWith(POST_COMPACTION_ATTACHMENTS_MESSAGE_ID_PREFIX);
    const deleteMessage = historyService.deleteMessage.bind(historyService);
    spyOn(historyService, "deleteMessage").mockImplementation((ws, id) =>
      isRow(id) ? Promise.resolve(Err("disk full")) : deleteMessage(ws, id)
    );
    const deleteUnderAdmission = historyService.deleteMessageUnderAdmission.bind(historyService);
    spyOn(historyService, "deleteMessageUnderAdmission").mockImplementation((ws, capture, id) =>
      isRow(id) ? Promise.resolve(Err("disk full")) : deleteUnderAdmission(ws, capture, id)
    );

    const aiEmitter = new EventEmitter();
    const streamMessage = mock((..._args: unknown[]) => {
      aiEmitter.emit("error", {
        workspaceId,
        messageId: "assistant-ctx-exceeded",
        error: "Context length exceeded",
        errorType: "context_exceeded",
      });
      return Promise.resolve(contextExceededResult("assistant-ctx-exceeded"));
    });
    const { session } = await createAgentSessionHarness({
      workspaceId,
      config,
      historyService,
      aiEmitter,
      aiServiceOverrides: {
        streamMessage,
        getWorkspaceMetadata: mock(() => Promise.resolve(Err("nope"))),
      },
    });

    await session.resumeStream({
      model: "openai:gpt-4o",
      agentId: "exec",
    } as unknown as SendMessageOptions);
    expect(
      await Promise.race([
        session.waitForPendingStreamErrorRecoveryDecision("assistant-ctx-exceeded"),
        new Promise((_, reject) => setTimeout(() => reject(new Error("decision timeout")), 1000)),
      ])
    ).toBe("terminal");

    expect(streamMessage).toHaveBeenCalledTimes(1);
    const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
    expect(history.success && history.data.some((message) => isRow(message.id))).toBe(true);
    expect(await fsPromises.stat(postCompactionPath).then(() => true)).toBe(true);

    await session.dispose();
  });

  // Waiters (task/workspace-turn stream-error settlement) treat the resolved
  // decision as "the retry outcome is known". Resolving while retry startup is
  // still in flight would let a pre-stream startup failure (no further error
  // event) leave a child task running until the parent times out.
  test("recovery decision resolves only after the context retry startup outcome is known", async () => {
    const workspaceId = "ws-decision";
    const { historyService, config, sessionDir } = await createSessionsFixture(workspaceId);
    await createPersistedPostCompactionState({
      filePath: path.join(sessionDir, "post-compaction.json"),
      diffs: [{ path: "/tmp/foo.ts", diff: "@@ -1 +1 @@\n-foo\n+bar\n", truncated: false }],
    });

    await historyService.appendToHistory(workspaceId, {
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "Continue" }],
      metadata: { timestamp: 1100 },
    });

    const aiEmitter = new EventEmitter();
    let releaseRetryStartup!: () => void;
    const retryStartupGate = new Promise<void>((resolve) => {
      releaseRetryStartup = resolve;
    });
    let retryStartupInvoked!: () => void;
    const retryStartupStarted = new Promise<void>((resolve) => {
      retryStartupInvoked = resolve;
    });

    let callCount = 0;
    const streamMessage = mock(async (..._args: unknown[]) => {
      callCount += 1;
      if (callCount === 1) {
        aiEmitter.emit("error", {
          workspaceId,
          messageId: "assistant-ctx-exceeded",
          error: "Context length exceeded",
          errorType: "context_exceeded",
        });
        return contextExceededResult("assistant-ctx-exceeded");
      }
      // Retry startup in flight: hold it until the test releases, then fail
      // pre-stream (e.g. commitPartial / history read failure).
      retryStartupInvoked();
      await retryStartupGate;
      return {
        success: false as const,
        error: { type: "unknown" as const, raw: "startup failed before stream" },
      };
    });

    const { session } = await createAgentSessionHarness({
      workspaceId,
      config,
      historyService,
      aiEmitter,
      aiServiceOverrides: {
        streamMessage,
        // No workspace metadata: the retry path must not depend on a runtime.
        getWorkspaceMetadata: mock(() => Promise.resolve(Err("nope"))),
      },
    });

    const options: SendMessageOptions = {
      model: "openai:gpt-4o",
      agentId: "exec",
    } as unknown as SendMessageOptions;

    await session.resumeStream(options);

    // The error event began a recovery decision and kicked off the retry.
    await Promise.race([
      retryStartupStarted,
      new Promise((_, reject) => setTimeout(() => reject(new Error("retry never started")), 1000)),
    ]);

    let decidedOutcome: string | undefined;
    let decided = false;
    const decision = session
      .waitForPendingStreamErrorRecoveryDecision("assistant-ctx-exceeded")
      .then((outcome) => {
        decided = true;
        decidedOutcome = outcome;
      });

    // Retry startup still in flight: the decision must stay pending so waiters
    // cannot observe a transient PREPARING as a started recovery.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(decided).toBe(false);

    releaseRetryStartup();
    await Promise.race([
      decision,
      new Promise((_, reject) => setTimeout(() => reject(new Error("decision timeout")), 1000)),
    ]);

    // Startup failed pre-stream: the recorded outcome must be terminal so
    // task settlement can interrupt the child instead of waiting forever.
    expect(decided).toBe(true);
    expect(decidedOutcome).toBe("terminal");
    expect(session.isPreparingTurn()).toBe(false);
    expect(callCount).toBe(2);

    await session.dispose();
  });

  // Overlapping recovery episodes: a retry stream can emit its own error
  // before the original retry path resumes. Each error event must get its own
  // per-attempt decision — folding them into one would let the first
  // episode's "retry-started" mask the second's "terminal", leaving task
  // settlement convinced the (dead) retry is still carrying the turn.
  test("a retry that starts and then fails terminally records separate per-attempt outcomes", async () => {
    const workspaceId = "ws-overlap";
    const { historyService, config, sessionDir } = await createSessionsFixture(workspaceId);
    await createPersistedPostCompactionState({
      filePath: path.join(sessionDir, "post-compaction.json"),
      diffs: [{ path: "/tmp/foo.ts", diff: "@@ -1 +1 @@\n-foo\n+bar\n", truncated: false }],
    });

    await historyService.appendToHistory(workspaceId, {
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "Continue" }],
      metadata: { timestamp: 1100 },
    });

    const aiEmitter = new EventEmitter();
    let callCount = 0;
    const streamMessage = mock((..._args: unknown[]) => {
      callCount += 1;
      if (callCount === 1) {
        aiEmitter.emit("error", {
          workspaceId,
          messageId: "assistant-attempt-1",
          error: "Context length exceeded",
          errorType: "context_exceeded",
        });
        return Promise.resolve(contextExceededResult("assistant-attempt-1"));
      }
      // The retry's startup succeeds, but the stream dies immediately with a
      // terminal error — emitted before the original retry path resumes.
      aiEmitter.emit("error", {
        workspaceId,
        messageId: "assistant-attempt-2",
        error: "The model refused to continue",
        errorType: "model_refusal",
      });
      return Promise.resolve({
        success: true as const,
        data: createFailedTurnHandle("assistant-attempt-2", {
          error: "The model refused to continue",
          errorType: "model_refusal",
        }),
      });
    });

    const { session } = await createAgentSessionHarness({
      workspaceId,
      config,
      historyService,
      aiEmitter,
      aiServiceOverrides: {
        streamMessage,
        // No workspace metadata: the retry path must not depend on a runtime.
        getWorkspaceMetadata: mock(() => Promise.resolve(Err("nope"))),
      },
    });

    const options: SendMessageOptions = {
      model: "openai:gpt-4o",
      agentId: "exec",
    } as unknown as SendMessageOptions;

    await session.resumeStream(options);

    const withTimeout = <T>(promise: Promise<T>, label: string): Promise<T> =>
      Promise.race([
        promise,
        new Promise<T>((_, reject) =>
          setTimeout(() => reject(new Error(`${label} timeout`)), 1000)
        ),
      ]);

    // Attempt 1's recovery started a retry; attempt 2 (the retry's own death)
    // is terminal. A settlement waiter keyed to attempt 2 must see terminal.
    expect(
      await withTimeout(
        session.waitForPendingStreamErrorRecoveryDecision("assistant-attempt-1"),
        "attempt-1 decision"
      )
    ).toBe("retry-started");
    expect(
      await withTimeout(
        session.waitForPendingStreamErrorRecoveryDecision("assistant-attempt-2"),
        "attempt-2 decision"
      )
    ).toBe("terminal");
    expect(callCount).toBe(2);

    await session.dispose();
  });

  // The row is durable: a turn that fails before the ack must not append a second copy.
  test("a failed turn keeps its attachments row and the next turn reuses it", async () => {
    const workspaceId = "ws-reuse";
    const { historyService, config, sessionDir } = await createSessionsFixture(workspaceId);
    await createPersistedPostCompactionState({
      filePath: path.join(sessionDir, "post-compaction.json"),
      diffs: [{ path: "/tmp/foo.ts", diff: "@@ -1 +1 @@\n-foo\n+bar\n", truncated: false }],
    });
    await historyService.appendToHistory(workspaceId, {
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "Continue" }],
      metadata: { timestamp: 1100 },
    });

    let callCount = 0;
    const streamMessage = mock((..._args: unknown[]) => {
      callCount += 1;
      if (callCount === 1) {
        return Promise.resolve({
          success: false as const,
          error: { type: "unknown" as const, raw: "startup failed before stream" },
        });
      }
      return Promise.resolve({
        success: true as const,
        data: createStartedTurnHandle(session.closingSignal, "assistant-next"),
      });
    });
    const { session } = await createAgentSessionHarness({
      workspaceId,
      config,
      historyService,
      aiServiceOverrides: {
        streamMessage,
        getWorkspaceMetadata: mock(() => Promise.resolve(Err("nope"))),
      },
    });
    const options = { model: "openai:gpt-4o", agentId: "exec" } as unknown as SendMessageOptions;

    await session.resumeStream(options);
    // The manual Retry resumes the request past the failed turn's attachments row.
    expect(await session.resumeStream(options)).toEqual({ success: true, data: { started: true } });

    expect(callCount).toBe(2);
    const attachmentRowIds = (messages: MuxMessage[]) =>
      messages
        .filter((message) => message.id.startsWith(POST_COMPACTION_ATTACHMENTS_MESSAGE_ID_PREFIX))
        .map((message) => message.id);
    const requestRowIds = (call: number) =>
      attachmentRowIds(
        (
          (streamMessage as ReturnType<typeof mock>).mock.calls[call][0] as {
            messages: MuxMessage[];
          }
        ).messages
      );
    const firstRowIds = requestRowIds(0);
    expect(firstRowIds).toHaveLength(1);
    expect(requestRowIds(1)).toEqual(firstRowIds);
    const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
    expect(history.success && attachmentRowIds(history.data)).toEqual(firstRowIds);

    await session.dispose();
  });

  // A publication that lands while a turn builds its row must not leave that row in the new
  // window: the next turn would reuse it and send the older snapshot's attachments.
  test("a publication while a turn builds its row skips the row, so the next turn sends the new snapshot", async () => {
    const workspaceId = "ws-publication-race";
    const model = "openai:gpt-4o";
    const firstCompletion = Promise.withResolvers<Awaited<TurnStreamHandle["completion"]>>();
    const settled = Promise.withResolvers<void>();
    const streamMessage = mock((..._args: unknown[]) =>
      Promise.resolve({
        success: true as const,
        data:
          streamMessage.mock.calls.length === 1
            ? { messageId: "assistant-first", completion: firstCompletion.promise }
            : createStartedTurnHandle(h.session.closingSignal, "assistant-next"),
      })
    );
    const h = await createAgentSessionHarness({
      workspaceId,
      onTurnSettled: () => settled.resolve(),
      aiServiceOverrides: { streamMessage },
    });
    const publish = (id: string) => publishEditWindow(h, workspaceId, id, model);
    // Publication B lands after the first turn read snapshot A and before it appends A's row.
    let publishedB = false;
    const reports = spyOn(AttachmentService, "generateCompletedReportsAttachment");
    reports.mockImplementation(async () => {
      if (!publishedB) {
        publishedB = true;
        await publish("b");
      }
      return null;
    });
    const attachmentRows = (messages: MuxMessage[]) =>
      messages.filter((message) =>
        message.id.startsWith(POST_COMPACTION_ATTACHMENTS_MESSAGE_ID_PREFIX)
      );
    const sentRows = (call: number) =>
      attachmentRows((streamMessage.mock.calls[call][0] as { messages: MuxMessage[] }).messages);
    const started = { success: true as const, data: { started: true } };

    try {
      await publish("a");
      await h.historyService.appendToHistory(workspaceId, createMuxMessage("user-1", "user", "go"));

      expect(await h.session.resumeStream({ model, agentId: "exec" })).toEqual(started);
      expect(publishedB).toBe(true);
      expect(sentRows(0)).toHaveLength(0);
      const history = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(history.success && attachmentRows(history.data)).toEqual([]);

      firstCompletion.resolve({ status: "aborted", abortReason: "user" });
      await settled.promise;
      expect(await h.session.resumeStream({ model, agentId: "exec" })).toEqual(started);
      const sent = sentRows(1);
      expect(sent).toHaveLength(1);
      expect(JSON.stringify(sent[0].parts)).toContain("/b.ts");
    } finally {
      reports.mockRestore();
      firstCompletion.resolve({ status: "aborted", abortReason: "user" });
      await h.cleanup();
    }
  });

  /**
   * Run a first turn after a compaction (it sends and acknowledges the attachments row), then
   * edit `editMessageId`. History: user-0, compaction boundary, user-1, row, reply.
   * @returns the attachments row IDs that the first turn and the edit turn sent
   */
  async function editAfterAttachmentsTurn(workspaceId: string, editMessageId: string) {
    const model = "openai:gpt-4o";
    const firstCompletion = Promise.withResolvers<Awaited<TurnStreamHandle["completion"]>>();
    const streamMessage = mock((..._args: unknown[]) =>
      Promise.resolve({
        success: true as const,
        data:
          streamMessage.mock.calls.length === 1
            ? { messageId: "assistant-first", completion: firstCompletion.promise }
            : createStartedTurnHandle(h.session.closingSignal, "assistant-edit"),
      })
    );
    const h = await createAgentSessionHarness({
      workspaceId,
      aiServiceOverrides: { streamMessage },
    });
    const consumer = spyOn(
      (h.session as unknown as { coordinator: { consumeCompletion: () => Promise<void> } })
        .coordinator,
      "consumeCompletion"
    );
    const sentRowIds = (call: number) =>
      (streamMessage.mock.calls[call][0] as { messages: MuxMessage[] }).messages
        .filter((message) => message.id.startsWith(POST_COMPACTION_ATTACHMENTS_MESSAGE_ID_PREFIX))
        .map((message) => message.id);

    try {
      await h.historyService.appendToHistory(workspaceId, createMuxMessage("user-0", "user", "hi"));
      await publishEditWindow(h, workspaceId, "a", model);
      await h.historyService.appendToHistory(workspaceId, createMuxMessage("user-1", "user", "go"));
      await h.session.resumeStream({ model, agentId: "exec" });
      const policy = consumer.mock.results.at(-1);
      assert(policy?.type === "return", "Expected the first turn's completion consumer");
      firstCompletion.resolve({
        status: "completed",
        streamEnd: {
          type: "stream-end",
          workspaceId,
          metadata: { model },
          parts: [{ type: "text", text: "done" }],
        },
      });
      await policy.value;

      const edited = await h.session.sendMessage("edited", {
        model,
        agentId: "exec",
        editMessageId,
      });
      expect(edited.success).toBe(true);
      // An edit starts its stream in the background.
      for (let i = 0; i < 100 && streamMessage.mock.calls.length < 2; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return { first: sentRowIds(0), edit: sentRowIds(1) };
    } finally {
      consumer.mockRestore();
      firstCompletion.resolve({ status: "aborted", abortReason: "user" });
      await h.cleanup();
    }
  }

  // An edit cuts from its prompt, so it also cuts the row stored after that prompt. The first
  // turn acknowledged the snapshot, so no later turn writes the row again.
  test("an edit of the prompt before the attachments row keeps the row", async () => {
    const sent = await editAfterAttachmentsTurn("ws-edit-keeps-row", "user-1");
    expect(sent.first).toHaveLength(1);
    expect(sent.edit).toEqual(sent.first);
  });

  test("an edit before the compaction boundary drops the row with its window", async () => {
    const sent = await editAfterAttachmentsTurn("ws-edit-drops-row", "user-0");
    expect(sent.first).toHaveLength(1);
    expect(sent.edit).toEqual([]);
  });

  // A turn that reuses a failed turn's row must not acknowledge a snapshot published after its
  // history read: that row carries the older snapshot, so the newer diffs would never be sent.
  test("a publication before a turn reuses its row keeps the new snapshot pending", async () => {
    const workspaceId = "ws-publication-reuse-race";
    const model = "openai:gpt-4o";
    const secondCompletion = Promise.withResolvers<Awaited<TurnStreamHandle["completion"]>>();
    const streamMessage = mock((..._args: unknown[]) => {
      const call = streamMessage.mock.calls.length;
      if (call === 1) {
        return Promise.resolve({
          success: false as const,
          error: { type: "unknown" as const, raw: "startup failed before stream" },
        });
      }
      return Promise.resolve({
        success: true as const,
        data:
          call === 2
            ? { messageId: "assistant-second", completion: secondCompletion.promise }
            : createStartedTurnHandle(h.session.closingSignal, "assistant-next"),
      });
    });
    const h = await createAgentSessionHarness({
      workspaceId,
      aiServiceOverrides: { streamMessage },
    });
    const session = h.session as unknown as {
      coordinator: { consumeCompletion: (...args: never[]) => Promise<void> };
      getPostCompactionAttachmentsIfNeeded: (includeReadFiles: boolean) => Promise<unknown>;
    };
    const publish = (id: string) => publishEditWindow(h, workspaceId, id, model);
    // Publication B lands after the second turn read window A and before it captures the
    // pending state, so that turn captures B while its request still holds A's row.
    let publishB = false;
    const captureAttachments = session.getPostCompactionAttachmentsIfNeeded.bind(session);
    const capture = spyOn(session, "getPostCompactionAttachmentsIfNeeded");
    const consumer = spyOn(session.coordinator, "consumeCompletion");
    capture.mockImplementation(async (includeReadFiles) => {
      if (publishB) {
        publishB = false;
        await publish("b");
      }
      return captureAttachments(includeReadFiles);
    });
    const sentRows = (call: number) =>
      (streamMessage.mock.calls[call][0] as { messages: MuxMessage[] }).messages.filter((message) =>
        message.id.startsWith(POST_COMPACTION_ATTACHMENTS_MESSAGE_ID_PREFIX)
      );
    const started = { success: true as const, data: { started: true } };

    try {
      await publish("a");
      await h.historyService.appendToHistory(workspaceId, createMuxMessage("user-1", "user", "go"));
      await h.session.resumeStream({ model, agentId: "exec" });
      expect(sentRows(0)).toHaveLength(1);

      publishB = true;
      expect(await h.session.resumeStream({ model, agentId: "exec" })).toEqual(started);
      expect(publishB).toBe(false);
      const policy = consumer.mock.results.at(-1);
      assert(policy?.type === "return", "Expected the second turn's completion consumer");
      secondCompletion.resolve({
        status: "completed",
        streamEnd: {
          type: "stream-end",
          workspaceId,
          metadata: { model },
          parts: [{ type: "text", text: "done" }],
        },
      });
      await policy.value;

      expect(await h.session.resumeStream({ model, agentId: "exec" })).toEqual(started);
      const sent = sentRows(2);
      expect(sent).toHaveLength(1);
      expect(JSON.stringify(sent[0].parts)).toContain("/b.ts");
    } finally {
      capture.mockRestore();
      consumer.mockRestore();
      secondCompletion.resolve({ status: "aborted", abortReason: "user" });
      await h.cleanup();
    }
  });
});
