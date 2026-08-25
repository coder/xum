import { describe, expect, mock, spyOn, test } from "bun:test";

import type { MuxMessageMetadata } from "@/common/types/message";
import { Err, Ok } from "@/common/types/result";
import type { WorkspaceGoalService } from "./workspaceGoalService";
import { createAgentSessionHarness } from "./agentSession.testHarness";
import type { AIService } from "./aiService";

const TEST_MODEL = "anthropic:claude-sonnet-4-5";
const WORKSPACE_TURN_CORRELATION = {
  type: "workspace-turn-task",
  taskHandleId: "wst_preparing",
  ownerWorkspaceId: "owner-workspace",
  turnId: "turn-preparing",
} as const;

function toolCallEndEvent(workspaceId: string): Record<string, unknown> {
  return {
    type: "tool-call-end",
    workspaceId,
    messageId: "assistant-1",
    toolCallId: "tool-call-1",
    toolName: "bash",
    result: { success: true },
    timestamp: Date.now(),
  };
}

function streamStartEvent(workspaceId: string): Record<string, unknown> {
  return {
    type: "stream-start",
    workspaceId,
    messageId: "assistant-1",
    model: TEST_MODEL,
    startTime: Date.now(),
  };
}

function streamAbortEvent(
  workspaceId: string,
  abortReason: "system" | "user"
): Record<string, unknown> {
  return {
    type: "stream-abort",
    workspaceId,
    messageId: "assistant-1",
    abortReason,
    metadata: { duration: 1 },
  };
}

async function waitForCondition(condition: () => boolean, timeoutMs = 500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return condition();
}

describe("AgentSession queued message tool-call dispatch", () => {
  test("counts only a different direct preparing send as a superseding predecessor", async () => {
    const sessionHolder: {
      current?: {
        hasQueuedOrDispatchingEntry(
          continuationMetadata?: Extract<MuxMessageMetadata, { type: "workspace-turn-task" }>
        ): boolean;
        hasPendingWorkspaceTurnContinuation(
          continuationMetadata: Extract<MuxMessageMetadata, { type: "workspace-turn-task" }>
        ): boolean;
      };
    } = {};
    let preparingState:
      | {
          sameTurn: boolean;
          differentTurn: boolean;
          uncorrelated: boolean;
          pendingSameTurn: boolean;
          pendingDifferentTurn: boolean;
        }
      | undefined;
    const streamMessage = mock(() => {
      const session = sessionHolder.current;
      preparingState = {
        sameTurn: session?.hasQueuedOrDispatchingEntry(WORKSPACE_TURN_CORRELATION) === true,
        differentTurn:
          session?.hasQueuedOrDispatchingEntry({
            ...WORKSPACE_TURN_CORRELATION,
            turnId: "turn-different",
          }) === true,
        uncorrelated: session?.hasQueuedOrDispatchingEntry() === true,
        pendingSameTurn:
          session?.hasPendingWorkspaceTurnContinuation(WORKSPACE_TURN_CORRELATION) === true,
        pendingDifferentTurn:
          session?.hasPendingWorkspaceTurnContinuation({
            ...WORKSPACE_TURN_CORRELATION,
            turnId: "turn-different",
          }) === true,
      };
      return Promise.resolve(Ok(undefined));
    });
    const { session, cleanup } = await createAgentSessionHarness({
      workspaceId: "queue-dispatch-preparing-predecessor",
      aiServiceOverrides: {
        streamMessage: streamMessage as unknown as AIService["streamMessage"],
      },
    });
    sessionHolder.current = session;

    try {
      expect(session.hasQueuedOrDispatchingEntry()).toBe(false);
      const result = await session.sendMessage("direct send", {
        model: TEST_MODEL,
        agentId: "exec",
        muxMetadata: WORKSPACE_TURN_CORRELATION,
      });

      expect(result.success).toBe(true);
      expect(preparingState).toEqual({
        sameTurn: false,
        differentTurn: true,
        uncorrelated: true,
        pendingSameTurn: true,
        pendingDifferentTurn: false,
      });
      expect(session.hasQueuedOrDispatchingEntry()).toBe(false);
    } finally {
      session.dispose();
      await cleanup();
    }
  });

  test("preserves correlation for same-turn queued and dequeued predecessors", async () => {
    const { session, cleanup } = await createAgentSessionHarness({
      workspaceId: "queue-dispatch-same-turn-predecessor",
    });
    const differentCorrelation = {
      ...WORKSPACE_TURN_CORRELATION,
      turnId: "turn-different",
    };

    try {
      session.queueMessage(
        "queued continuation",
        { model: TEST_MODEL, agentId: "exec", muxMetadata: WORKSPACE_TURN_CORRELATION },
        { synthetic: true }
      );
      expect(session.hasQueuedOrDispatchingEntry(WORKSPACE_TURN_CORRELATION)).toBe(false);
      expect(session.hasQueuedOrDispatchingEntry(differentCorrelation)).toBe(true);

      session.queueMessage(
        "second queued continuation",
        { model: TEST_MODEL, agentId: "exec", muxMetadata: WORKSPACE_TURN_CORRELATION },
        { synthetic: true }
      );
      expect(session.hasQueuedOrDispatchingEntry(WORKSPACE_TURN_CORRELATION)).toBe(false);

      session.queueMessage(
        "unrelated predecessor",
        { model: TEST_MODEL, agentId: "exec" },
        {
          synthetic: true,
        }
      );
      expect(session.hasQueuedOrDispatchingEntry(WORKSPACE_TURN_CORRELATION)).toBe(true);

      const sendMessage = spyOn(session, "sendMessage").mockResolvedValue(Ok(undefined));
      session.sendQueuedMessages();
      expect(session.hasQueuedOrDispatchingEntry(WORKSPACE_TURN_CORRELATION)).toBe(true);
      expect(session.hasQueuedOrDispatchingEntry(differentCorrelation)).toBe(true);
      sendMessage.mockRestore();
    } finally {
      session.dispose();
      await cleanup();
    }
  });

  test("waits for stream-end instead of interrupting between sibling tool results", async () => {
    const workspaceId = "queue-dispatch-full-step";
    const { session, cleanup, aiEmitter, aiService } = await createAgentSessionHarness({
      workspaceId,
    });
    const stopStream = spyOn(aiService, "stopStream").mockResolvedValue(Ok(undefined));
    const sendQueuedMessages = spyOn(session, "sendQueuedMessages").mockImplementation(
      () => undefined
    );

    try {
      aiEmitter.emit("stream-start", streamStartEvent(workspaceId));
      session.queueMessage("follow up", { model: TEST_MODEL, agentId: "exec" });

      aiEmitter.emit("tool-call-end", toolCallEndEvent(workspaceId));
      aiEmitter.emit("tool-call-end", {
        ...toolCallEndEvent(workspaceId),
        toolCallId: "tool-call-2",
      });

      expect(stopStream).not.toHaveBeenCalled();
      expect(sendQueuedMessages).not.toHaveBeenCalled();

      aiEmitter.emit("stream-end", {
        type: "stream-end",
        workspaceId,
        messageId: "assistant-1",
        parts: [],
        metadata: {
          model: TEST_MODEL,
          contextUsage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
          providerMetadata: {},
          finishReason: "tool-calls",
        },
      });

      const didDispatch = await waitForCondition(() => sendQueuedMessages.mock.calls.length > 0);
      expect(didDispatch).toBe(true);
      expect(sendQueuedMessages).toHaveBeenCalledTimes(1);
    } finally {
      sendQueuedMessages.mockRestore();
      stopStream.mockRestore();
      session.dispose();
      await cleanup();
    }
  });

  test("soft-stops after a provider-executed tool result and dispatches after abort", async () => {
    const workspaceId = "queue-dispatch-provider-tool";
    const { session, cleanup, aiEmitter, aiService } = await createAgentSessionHarness({
      workspaceId,
    });
    const stopStream = spyOn(aiService, "stopStream").mockResolvedValue(Ok(undefined));
    const sendQueuedMessages = spyOn(session, "sendQueuedMessages").mockImplementation(
      () => undefined
    );

    try {
      aiEmitter.emit("stream-start", streamStartEvent(workspaceId));
      session.queueMessage("follow up", { model: TEST_MODEL, agentId: "exec" });

      aiEmitter.emit("tool-call-end", {
        ...toolCallEndEvent(workspaceId),
        toolName: "web_search",
        providerExecuted: true,
      });

      expect(stopStream).toHaveBeenCalledWith(workspaceId, {
        soft: true,
        abortReason: "system",
      });

      aiEmitter.emit("stream-abort", streamAbortEvent(workspaceId, "system"));
      const didDispatch = await waitForCondition(() => sendQueuedMessages.mock.calls.length > 0);
      expect(didDispatch).toBe(true);
      expect(sendQueuedMessages).toHaveBeenCalledTimes(1);
    } finally {
      sendQueuedMessages.mockRestore();
      stopStream.mockRestore();
      session.dispose();
      await cleanup();
    }
  });

  test("waits for every known sibling before stopping after a provider-executed result", async () => {
    const workspaceId = "queue-dispatch-provider-siblings";
    const { session, cleanup, aiEmitter, aiService } = await createAgentSessionHarness({
      workspaceId,
    });
    const stopStream = spyOn(aiService, "stopStream").mockResolvedValue(Ok(undefined));

    try {
      aiEmitter.emit("stream-start", streamStartEvent(workspaceId));
      session.queueMessage("follow up", { model: TEST_MODEL, agentId: "exec" });
      aiEmitter.emit("tool-call-start", {
        type: "tool-call-start",
        workspaceId,
        messageId: "assistant-1",
        toolCallId: "provider-tool-1",
        toolName: "web_search",
        args: {},
        tokens: 0,
        timestamp: Date.now(),
      });
      aiEmitter.emit("tool-call-start", {
        type: "tool-call-start",
        workspaceId,
        messageId: "assistant-1",
        toolCallId: "provider-tool-2",
        toolName: "web_search",
        args: {},
        tokens: 0,
        timestamp: Date.now(),
      });

      aiEmitter.emit("tool-call-end", {
        ...toolCallEndEvent(workspaceId),
        toolCallId: "provider-tool-1",
        toolName: "web_search",
        providerExecuted: true,
      });
      expect(stopStream).not.toHaveBeenCalled();

      aiEmitter.emit("tool-call-end", {
        ...toolCallEndEvent(workspaceId),
        toolCallId: "provider-tool-2",
        toolName: "web_search",
        providerExecuted: true,
      });
      expect(stopStream).toHaveBeenCalledTimes(1);
    } finally {
      stopStream.mockRestore();
      session.dispose();
      await cleanup();
    }
  });

  // Heartbeat force-queue drain path: a scheduled message queued while the session is IDLE
  // (e.g. a heartbeat deferred behind active descendant tasks) must ride along with the next
  // turn and drain at its stream-end, releasing the dedupe key so the next firing can enqueue.
  test("drains an idle-queued deduped message at the next turn's stream-end", async () => {
    const workspaceId = "queue-dispatch-idle-queued-drain";
    const { session, cleanup, aiEmitter } = await createAgentSessionHarness({
      workspaceId,
    });
    const sendMessage = spyOn(session, "sendMessage").mockResolvedValue(Ok(undefined));

    try {
      expect(session.isBusy()).toBe(false);
      const dispatchMode = session.queueMessage(
        "[Scheduled heartbeat] check in",
        { model: TEST_MODEL, agentId: "exec", queueDispatchMode: "turn-end" },
        { synthetic: true, dedupeKey: "heartbeat-request" }
      );
      expect(dispatchMode).toBe("turn-end");
      expect(session.hasQueuedDedupeKey("heartbeat-request")).toBe(true);

      // A duplicate firing while pending is dropped (coalescing).
      expect(
        session.queueMessage(
          "[Scheduled heartbeat] check in",
          { model: TEST_MODEL, agentId: "exec", queueDispatchMode: "turn-end" },
          { synthetic: true, dedupeKey: "heartbeat-request" }
        )
      ).toBeNull();

      // The next turn (e.g. a descendant-task terminal wake) starts and ends.
      aiEmitter.emit("stream-start", streamStartEvent(workspaceId));
      aiEmitter.emit("stream-end", {
        type: "stream-end",
        workspaceId,
        messageId: "assistant-1",
        parts: [{ type: "text", text: "wake turn done" }],
        metadata: {
          model: TEST_MODEL,
          contextUsage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
          providerMetadata: {},
          finishReason: "stop",
        },
      });

      const didDrain = await waitForCondition(
        () =>
          sendMessage.mock.calls.some((call) => call[0] === "[Scheduled heartbeat] check in") &&
          !session.hasQueuedMessages()
      );
      expect(didDrain).toBe(true);
      // Queue clear released the dedupe key: the next scheduled firing can enqueue again.
      expect(session.hasQueuedDedupeKey("heartbeat-request")).toBe(false);
    } finally {
      sendMessage.mockRestore();
      session.dispose();
      await cleanup();
    }
  });

  test("updates visible queued dispatch mode without dequeuing content", async () => {
    const workspaceId = "queue-dispatch-mode-update";
    const setMessageQueued = mock((_workspaceId: string, _queued: boolean) => undefined);
    const { session, cleanup, events } = await createAgentSessionHarness({
      workspaceId,
      captureEvents: true,
      backgroundProcessManagerOverrides: { setMessageQueued },
    });

    try {
      session.queueMessage(
        "hidden predecessor",
        { model: TEST_MODEL, agentId: "exec", queueDispatchMode: "turn-end" },
        { synthetic: true, agentInitiated: true }
      );
      session.queueMessage("my queued follow-up", {
        model: TEST_MODEL,
        agentId: "exec",
        queueDispatchMode: "tool-end",
      });

      expect(session.setQueuedMessageDispatchMode("tool-end")).toBe(true);
      const toolEndEvent = events.filter((event) => event.type === "queued-message-changed").at(-1);
      expect(toolEndEvent).toMatchObject({
        queuedMessages: ["my queued follow-up"],
        queueDispatchMode: "tool-end",
      });
      expect(setMessageQueued).toHaveBeenLastCalledWith(workspaceId, true);
      expect(session.hasQueuedMessages()).toBe(true);

      expect(session.setQueuedMessageDispatchMode("turn-end")).toBe(true);
      const turnEndEvent = events.filter((event) => event.type === "queued-message-changed").at(-1);
      expect(turnEndEvent).toMatchObject({
        queuedMessages: ["my queued follow-up"],
        queueDispatchMode: "turn-end",
      });
      expect(setMessageQueued).toHaveBeenLastCalledWith(workspaceId, false);
      expect(session.hasQueuedMessages()).toBe(true);
    } finally {
      session.dispose();
      await cleanup();
    }
  });

  test("restoreQueueToInput discards a queued heartbeat instead of restoring it", async () => {
    const workspaceId = "queue-dispatch-restore-discards-heartbeat";
    const { session, cleanup } = await createAgentSessionHarness({ workspaceId });

    try {
      session.queueMessage(
        "[Scheduled heartbeat] check in",
        { model: TEST_MODEL, agentId: "exec", queueDispatchMode: "turn-end" },
        { synthetic: true, dedupeKey: "heartbeat-request" }
      );
      expect(session.hasQueuedMessages()).toBe(true);

      const restoredTexts: string[] = [];
      const unsubscribe = session.onChatEvent((event) => {
        if (event.message.type === "restore-to-input") {
          restoredTexts.push(event.message.text);
        }
      });

      // A user interrupt restores queued input to the composer — the backend-initiated
      // heartbeat must be discarded, not surfaced as editable user text.
      session.restoreQueueToInput();
      unsubscribe();

      expect(restoredTexts).toEqual([]);
      expect(session.hasQueuedMessages()).toBe(false);
      // Dropping released the dedupe key so the next scheduled firing can enqueue again.
      expect(session.hasQueuedDedupeKey("heartbeat-request")).toBe(false);

      // Plain user input still restores.
      session.queueMessage("my own words", { model: TEST_MODEL, agentId: "exec" });
      const unsubscribeUser = session.onChatEvent((event) => {
        if (event.message.type === "restore-to-input") {
          restoredTexts.push(event.message.text);
        }
      });
      session.restoreQueueToInput();
      unsubscribeUser();
      expect(restoredTexts).toEqual(["my own words"]);
    } finally {
      session.dispose();
      await cleanup();
    }
  });

  test("synthetic background entries neither surface in queue UI nor restore over user input", async () => {
    const workspaceId = "queue-dispatch-hide-synthetic";
    const { session, cleanup } = await createAgentSessionHarness({ workspaceId });

    try {
      const queuedSnapshots: string[][] = [];
      const hasQueuedSnapshots: boolean[] = [];
      const restoredTexts: string[] = [];
      const canceledReasons: string[] = [];
      const unsubscribe = session.onChatEvent((event) => {
        if (event.message.type === "queued-message-changed") {
          queuedSnapshots.push(event.message.queuedMessages);
          hasQueuedSnapshots.push(event.message.hasQueuedMessages ?? false);
        }
        if (event.message.type === "restore-to-input") {
          restoredTexts.push(event.message.text);
        }
      });

      session.queueMessage(
        "Background monitor wake",
        { model: TEST_MODEL, agentId: "exec" },
        {
          synthetic: true,
          agentInitiated: true,
          onCanceled: (reason) => {
            canceledReasons.push(reason);
          },
        }
      );
      expect(hasQueuedSnapshots.at(-1)).toBe(true);
      expect(queuedSnapshots.at(-1)).toEqual([]);

      session.queueMessage("my own words", {
        model: TEST_MODEL,
        agentId: "exec",
        queueDispatchMode: "turn-end",
      });
      expect(queuedSnapshots.at(-1)).toEqual(["my own words"]);

      session.restoreQueueToInput();
      unsubscribe();

      expect(restoredTexts).toEqual(["my own words"]);
      expect(canceledReasons).toHaveLength(1);
      expect(session.hasQueuedMessages()).toBe(false);
    } finally {
      session.dispose();
      await cleanup();
    }
  });

  test("keeps a dequeued user message visible until its durable row is emitted", async () => {
    const workspaceId = "queue-dispatch-visible-handoff";
    const goalSyncStarted = Promise.withResolvers<void>();
    const goalSyncRelease = Promise.withResolvers<void>();
    const workspaceGoalService = {
      assertPricedModelForBudgetedGoal: mock(() => Promise.resolve(Ok(undefined))),
      syncGoalModeWithChatTail: mock(async () => {
        goalSyncStarted.resolve();
        await goalSyncRelease.promise;
      }),
      clearPendingContinuationForManualUserMessage: mock(() => undefined),
      acknowledgeUser: mock(() => Promise.resolve(null)),
    } as unknown as WorkspaceGoalService;
    const { session, cleanup, historyService, events } = await createAgentSessionHarness({
      workspaceId,
      workspaceGoalService,
      initStateManagerOverrides: { replayInit: mock(() => Promise.resolve()) },
      captureEvents: true,
    });
    const originalAppend = historyService.appendToHistory.bind(historyService);
    const appendStarted = Promise.withResolvers<void>();
    const appendRelease = Promise.withResolvers<void>();
    const appendSpy = spyOn(historyService, "appendToHistory").mockImplementation(
      async (...args) => {
        appendStarted.resolve();
        await appendRelease.promise;
        return originalAppend(...args);
      }
    );
    const followUp = "Follow up after compaction";
    const nextFollowUp = "A later queued message";
    const isFollowUpUserMessage = (event: (typeof events)[number]) =>
      event.type === "message" &&
      event.role === "user" &&
      event.parts.some((part) => part.type === "text" && part.text === followUp);
    const latestQueueEvent = () =>
      events.filter((event) => event.type === "queued-message-changed").at(-1);

    try {
      session.queueMessage(followUp, { model: TEST_MODEL, agentId: "exec" });
      const queueEventCountBeforeDispatch = events.filter(
        (event) => event.type === "queued-message-changed"
      ).length;
      session.sendQueuedMessages();
      await appendStarted.promise;

      expect(events.filter((event) => event.type === "queued-message-changed").length).toBe(
        queueEventCountBeforeDispatch + 1
      );
      expect(latestQueueEvent()?.queuedMessages).toEqual([followUp]);
      expect(events.some(isFollowUpUserMessage)).toBe(false);

      // Any queue mutation during persistence must retain the in-flight entry in the
      // authoritative projection instead of falling back to a stale renderer snapshot.
      session.queueMessage(nextFollowUp, { model: TEST_MODEL, agentId: "exec" });
      expect(latestQueueEvent()?.queuedMessages).toEqual([followUp, nextFollowUp]);

      appendRelease.resolve();
      await goalSyncStarted.promise;

      // Reconnect replay already includes the persisted user row, so its queue snapshot must
      // omit that dispatch while retaining later queued input.
      const replayEvents: Array<(typeof events)[number]> = [];
      await session.replayHistory(({ message }) => replayEvents.push(message));
      expect(replayEvents.some(isFollowUpUserMessage)).toBe(true);
      const replayQueueEvent = replayEvents.find(
        (event) => event.type === "queued-message-changed"
      );
      expect(replayQueueEvent?.queuedMessages).toEqual([nextFollowUp]);
      expect(replayQueueEvent?.isDispatching).toBe(false);

      goalSyncRelease.resolve();
      expect(await waitForCondition(() => events.some(isFollowUpUserMessage))).toBe(true);
      expect(
        await waitForCondition(() => latestQueueEvent()?.queuedMessages.join() === nextFollowUp)
      ).toBe(true);

      const userMessageIndex = events.findIndex(isFollowUpUserMessage);
      const handoffIndex = events.findIndex(
        (event, index) =>
          index > userMessageIndex &&
          event.type === "queued-message-changed" &&
          event.queuedMessages.join() === nextFollowUp
      );
      expect(userMessageIndex).toBeGreaterThanOrEqual(0);
      expect(handoffIndex).toBeGreaterThan(userMessageIndex);
    } finally {
      appendRelease.resolve();
      goalSyncRelease.resolve();
      appendSpy.mockRestore();
      session.dispose();
      await cleanup();
    }
  });

  test("cancel signal retracts a synthetic entry after dequeue while history append is preparing", async () => {
    const workspaceId = "queue-dispatch-cancel-preparing";
    const { session, cleanup, historyService, events } = await createAgentSessionHarness({
      workspaceId,
      captureEvents: true,
    });
    const originalAppend = historyService.appendToHistory.bind(historyService);
    let markAppendStarted: () => void = () => undefined;
    const appendStarted = new Promise<void>((resolve) => {
      markAppendStarted = resolve;
    });
    let releaseAppend: () => void = () => undefined;
    const appendRelease = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const appendSpy = spyOn(historyService, "appendToHistory").mockImplementation(
      async (...args) => {
        markAppendStarted();
        await appendRelease;
        return originalAppend(...args);
      }
    );

    try {
      const controller = new AbortController();
      const cancelState = { canceledBeforeAcceptance: false };
      const canceledReasons: string[] = [];
      session.queueMessage(
        "Background monitor wake",
        { model: TEST_MODEL, agentId: "exec" },
        {
          synthetic: true,
          agentInitiated: true,
          cancelState,
          cancelSignal: controller.signal,
          onCanceled: (reason) => {
            canceledReasons.push(reason);
          },
        }
      );

      session.sendQueuedMessages();
      await appendStarted;
      controller.abort("monitor canceled");
      releaseAppend();

      expect(await waitForCondition(() => canceledReasons.length === 1)).toBe(true);
      expect(await waitForCondition(() => !session.isBusy())).toBe(true);
      expect(canceledReasons).toEqual(["monitor canceled"]);

      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(history.success).toBe(true);
      if (history.success) {
        expect(
          history.data.some((message) =>
            message.parts.some(
              (part) => part.type === "text" && part.text === "Background monitor wake"
            )
          )
        ).toBe(false);
      }
      expect(
        events.some(
          (event) =>
            event.type === "message" &&
            event.role === "user" &&
            event.parts.some(
              (part) => part.type === "text" && part.text === "Background monitor wake"
            )
        )
      ).toBe(false);
    } finally {
      releaseAppend();
      appendSpy.mockRestore();
      session.dispose();
      await cleanup();
    }
  });

  test("rollback failure preserves the wake and continues acceptance", async () => {
    const workspaceId = "queue-dispatch-cancel-rollback-failure";
    const { session, cleanup, historyService } = await createAgentSessionHarness({ workspaceId });
    const originalAppend = historyService.appendToHistory.bind(historyService);
    let markAppendStarted: () => void = () => undefined;
    const appendStarted = new Promise<void>((resolve) => {
      markAppendStarted = resolve;
    });
    let releaseAppend: () => void = () => undefined;
    const appendRelease = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const appendSpy = spyOn(historyService, "appendToHistory").mockImplementation(
      async (...args) => {
        markAppendStarted();
        await appendRelease;
        return originalAppend(...args);
      }
    );
    const deleteMessagesSpy = spyOn(historyService, "deleteMessages").mockResolvedValue(
      Err("injected rollback failure")
    );

    try {
      const controller = new AbortController();
      const cancelState = { canceledBeforeAcceptance: false };
      const canceledReasons: string[] = [];
      let accepted = false;
      const sendPromise = session.sendMessage(
        "Background monitor wake",
        { model: TEST_MODEL, agentId: "exec" },
        {
          synthetic: true,
          agentInitiated: true,
          cancelState,
          cancelSignal: controller.signal,
          onCanceled: (reason) => {
            canceledReasons.push(reason);
          },
          onAccepted: () => {
            accepted = true;
          },
        }
      );

      await appendStarted;
      controller.abort("monitor canceled");
      releaseAppend();
      const result = await sendPromise;

      expect(result.success).toBe(true);
      expect(deleteMessagesSpy).toHaveBeenCalledTimes(1);
      expect(canceledReasons).toEqual([]);
      expect(cancelState.canceledBeforeAcceptance).toBe(false);
      expect(accepted).toBe(true);

      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(history.success).toBe(true);
      if (history.success) {
        expect(
          history.data.some((message) =>
            message.parts.some(
              (part) => part.type === "text" && part.text === "Background monitor wake"
            )
          )
        ).toBe(true);
      }
    } finally {
      releaseAppend();
      deleteMessagesSpy.mockRestore();
      appendSpy.mockRestore();
      session.dispose();
      await cleanup();
    }
  });

  test("verifies a committed rollback when batch deletion reports a post-write failure", async () => {
    const workspaceId = "queue-dispatch-cancel-post-write-failure";
    const { session, cleanup, historyService } = await createAgentSessionHarness({ workspaceId });
    const originalAppend = historyService.appendToHistory.bind(historyService);
    const originalDeleteMessages = historyService.deleteMessages.bind(historyService);
    let markAppendStarted: () => void = () => undefined;
    const appendStarted = new Promise<void>((resolve) => {
      markAppendStarted = resolve;
    });
    let releaseAppend: () => void = () => undefined;
    const appendRelease = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const appendSpy = spyOn(historyService, "appendToHistory").mockImplementation(
      async (...args) => {
        markAppendStarted();
        await appendRelease;
        return originalAppend(...args);
      }
    );
    const deleteMessagesSpy = spyOn(historyService, "deleteMessages").mockImplementation(
      async (...args) => {
        const result = await originalDeleteMessages(...args);
        expect(result.success).toBe(true);
        return Err("injected post-write failure");
      }
    );

    try {
      const controller = new AbortController();
      const cancelState = { canceledBeforeAcceptance: false };
      const canceledReasons: string[] = [];
      let accepted = false;
      const sendPromise = session.sendMessage(
        "Background monitor wake",
        { model: TEST_MODEL, agentId: "exec" },
        {
          synthetic: true,
          agentInitiated: true,
          cancelState,
          cancelSignal: controller.signal,
          onCanceled: (reason) => {
            canceledReasons.push(reason);
          },
          onAccepted: () => {
            accepted = true;
          },
        }
      );

      await appendStarted;
      controller.abort("monitor canceled");
      releaseAppend();
      const result = await sendPromise;

      expect(result.success).toBe(true);
      expect(deleteMessagesSpy).toHaveBeenCalledTimes(1);
      expect(canceledReasons).toEqual(["monitor canceled"]);
      expect(cancelState.canceledBeforeAcceptance).toBe(true);
      expect(accepted).toBe(false);

      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(history.success).toBe(true);
      if (history.success) {
        expect(
          history.data.some((message) =>
            message.parts.some(
              (part) => part.type === "text" && part.text === "Background monitor wake"
            )
          )
        ).toBe(false);
      }
    } finally {
      releaseAppend();
      deleteMessagesSpy.mockRestore();
      appendSpy.mockRestore();
      session.dispose();
      await cleanup();
    }
  });

  test("cancellation during goal sync crosses the acceptance point of no return", async () => {
    const workspaceId = "queue-dispatch-cancel-goal-reconcile";
    let markInitialSyncStarted: () => void = () => undefined;
    const initialSyncStarted = new Promise<void>((resolve) => {
      markInitialSyncStarted = resolve;
    });
    let releaseInitialSync: () => void = () => undefined;
    const initialSyncRelease = new Promise<void>((resolve) => {
      releaseInitialSync = resolve;
    });
    let syncCalls = 0;
    const syncGoalModeWithChatTail = mock(async () => {
      syncCalls += 1;
      if (syncCalls === 1) {
        markInitialSyncStarted();
        await initialSyncRelease;
      }
      return null;
    });
    const workspaceGoalService = {
      assertPricedModelForBudgetedGoal: mock(() => Promise.resolve(Ok(undefined))),
      syncGoalModeWithChatTail,
    } as unknown as WorkspaceGoalService;
    const { session, cleanup, historyService } = await createAgentSessionHarness({
      workspaceId,
      workspaceGoalService,
    });

    try {
      const controller = new AbortController();
      const cancelState = { canceledBeforeAcceptance: false };
      const canceledReasons: string[] = [];
      let accepted = false;
      const sendPromise = session.sendMessage(
        "Background monitor wake",
        { model: TEST_MODEL, agentId: "exec" },
        {
          synthetic: true,
          agentInitiated: true,
          cancelState,
          cancelSignal: controller.signal,
          onCanceled: (reason) => {
            canceledReasons.push(reason);
          },
          onAccepted: () => {
            accepted = true;
          },
        }
      );

      await initialSyncStarted;
      controller.abort("monitor canceled");
      releaseInitialSync();
      const result = await sendPromise;

      expect(result.success).toBe(true);
      expect(syncGoalModeWithChatTail).toHaveBeenCalledTimes(1);
      expect(canceledReasons).toEqual([]);
      expect(cancelState.canceledBeforeAcceptance).toBe(false);
      expect(accepted).toBe(true);

      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(history.success).toBe(true);
      if (history.success) {
        expect(
          history.data.some((message) =>
            message.parts.some(
              (part) => part.type === "text" && part.text === "Background monitor wake"
            )
          )
        ).toBe(true);
      }
    } finally {
      releaseInitialSync();
      session.dispose();
      await cleanup();
    }
  });

  test("disposed sessions finalize durable wakes after goal sync completes", async () => {
    const workspaceId = "queue-dispatch-disposed-after-goal-sync";
    let markSyncStarted: () => void = () => undefined;
    const syncStarted = new Promise<void>((resolve) => {
      markSyncStarted = resolve;
    });
    let releaseSync: () => void = () => undefined;
    const syncRelease = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });
    const syncGoalModeWithChatTail = mock(async () => {
      markSyncStarted();
      await syncRelease;
      return null;
    });
    const workspaceGoalService = {
      assertPricedModelForBudgetedGoal: mock(() => Promise.resolve(Ok(undefined))),
      syncGoalModeWithChatTail,
    } as unknown as WorkspaceGoalService;
    const { session, cleanup } = await createAgentSessionHarness({
      workspaceId,
      workspaceGoalService,
    });

    let disposed = false;
    try {
      const controller = new AbortController();
      const cancelState = { canceledBeforeAcceptance: false };
      let accepted = false;
      const sendPromise = session.sendMessage(
        "Background monitor wake",
        { model: TEST_MODEL, agentId: "exec" },
        {
          synthetic: true,
          agentInitiated: true,
          cancelState,
          cancelSignal: controller.signal,
          onAccepted: () => {
            accepted = true;
          },
        }
      );

      await syncStarted;
      session.dispose();
      disposed = true;
      releaseSync();
      const result = await sendPromise;

      expect(result.success).toBe(true);
      expect(accepted).toBe(true);
      expect(cancelState.canceledBeforeAcceptance).toBe(false);
    } finally {
      releaseSync();
      if (!disposed) session.dispose();
      await cleanup();
    }
  });

  test("every goal sync failure after the boundary finalizes the durable wake", async () => {
    const workspaceId = "queue-dispatch-cancel-goal-sync-failure";
    let markSyncStarted: () => void = () => undefined;
    const syncStarted = new Promise<void>((resolve) => {
      markSyncStarted = resolve;
    });
    let releaseSync: () => void = () => undefined;
    const syncRelease = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });
    const syncGoalModeWithChatTail = mock(async () => {
      markSyncStarted();
      await syncRelease;
      throw new Error("injected goal sync failure");
    });
    const workspaceGoalService = {
      assertPricedModelForBudgetedGoal: mock(() => Promise.resolve(Ok(undefined))),
      syncGoalModeWithChatTail,
    } as unknown as WorkspaceGoalService;
    const { session, cleanup, historyService } = await createAgentSessionHarness({
      workspaceId,
      workspaceGoalService,
    });

    try {
      const controller = new AbortController();
      const cancelState = { canceledBeforeAcceptance: false };
      const canceledReasons: string[] = [];
      let accepted = false;
      const sendPromise = session.sendMessage(
        "Background monitor wake",
        { model: TEST_MODEL, agentId: "exec" },
        {
          synthetic: true,
          agentInitiated: true,
          cancelState,
          cancelSignal: controller.signal,
          onCanceled: (reason) => {
            canceledReasons.push(reason);
          },
          onAccepted: () => {
            accepted = true;
          },
        }
      );

      await syncStarted;
      releaseSync();
      let syncError: unknown;
      try {
        await sendPromise;
      } catch (error) {
        syncError = error;
      }
      expect(syncError).toBeInstanceOf(Error);
      expect((syncError as Error).message).toContain("injected goal sync failure");

      expect(accepted).toBe(true);
      expect(canceledReasons).toEqual([]);
      expect(cancelState.canceledBeforeAcceptance).toBe(false);
      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(history.success).toBe(true);
      if (history.success) {
        expect(
          history.data.some((message) =>
            message.parts.some(
              (part) => part.type === "text" && part.text === "Background monitor wake"
            )
          )
        ).toBe(true);
      }
    } finally {
      releaseSync();
      session.dispose();
      await cleanup();
    }
  });

  test("hard user interrupt cancels a pending provider-tool dispatch", async () => {
    const workspaceId = "queue-dispatch-hard-user-interrupt";
    const { session, cleanup, aiEmitter, aiService } = await createAgentSessionHarness({
      workspaceId,
    });
    const stopStream = spyOn(aiService, "stopStream").mockResolvedValue(Ok(undefined));
    const sendQueuedMessages = spyOn(session, "sendQueuedMessages").mockImplementation(
      () => undefined
    );

    try {
      aiEmitter.emit("stream-start", streamStartEvent(workspaceId));
      session.queueMessage("follow up", { model: TEST_MODEL, agentId: "exec" });
      aiEmitter.emit("tool-call-end", {
        ...toolCallEndEvent(workspaceId),
        toolName: "web_search",
        providerExecuted: true,
      });
      expect(stopStream).toHaveBeenCalledTimes(1);

      const interruptResult = await session.interruptStream();
      expect(interruptResult.success).toBe(true);
      // The native soft-stop can still win the event race after the hard user interrupt.
      aiEmitter.emit("stream-abort", streamAbortEvent(workspaceId, "system"));

      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(sendQueuedMessages).not.toHaveBeenCalled();
    } finally {
      sendQueuedMessages.mockRestore();
      stopStream.mockRestore();
      session.dispose();
      await cleanup();
    }
  });
});
