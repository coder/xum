import { describe, expect, mock, spyOn, test } from "bun:test";

import { EventEmitter } from "node:events";

import type { SendMessageOptions } from "@/common/orpc/types";
import { createMuxMessage, type MuxMessageMetadata } from "@/common/types/message";
import { Err, Ok } from "@/common/types/result";
import { GOAL_CONTINUATION_KIND } from "@/constants/goals";
import type { WorkspaceGoalService } from "./workspaceGoalService";
import {
  createAgentSessionHarness,
  createStartedTurnHandle,
  type AgentSessionHarnessOptions,
} from "./agentSession.testHarness";
import type { AIService, StreamMessageOptions } from "./aiService";
import type { HistoryService } from "./historyService";

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
  abortReason: "system" | "user" | "queued-message"
): Record<string, unknown> {
  return {
    type: "stream-abort",
    workspaceId,
    messageId: "assistant-1",
    abortReason,
    metadata: { duration: 1 },
  };
}

function streamEndEvent(workspaceId: string): Record<string, unknown> {
  return {
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
  };
}

/**
 * Session whose engine double behaves like the real one for turn phases: every
 * streamMessage call emits stream-start before resolving, so the session is STREAMING
 * (not back to IDLE) once a send or resume returns.
 */
async function createStreamingTurnHarness(
  workspaceId: string,
  setup?: {
    harness?: Partial<Omit<AgentSessionHarnessOptions, "workspaceId" | "aiEmitter">>;
    seedHistory?: (historyService: HistoryService) => Promise<void>;
    sendOptions?: Partial<SendMessageOptions>;
    sendInternal?: { synthetic?: boolean; agentInitiated?: boolean };
  }
) {
  const aiEmitter = new EventEmitter();
  const streamMessage = mock((_options: StreamMessageOptions) => {
    aiEmitter.emit("stream-start", streamStartEvent(workspaceId));
    return Promise.resolve(Ok(createStartedTurnHandle("assistant-1")));
  });
  const harness = await createAgentSessionHarness({
    ...setup?.harness,
    workspaceId,
    aiEmitter,
    aiServiceOverrides: { streamMessage: streamMessage as unknown as AIService["streamMessage"] },
  });
  await setup?.seedHistory?.(harness.historyService);
  const sent = await harness.session.sendMessage(
    "run the checks",
    { model: TEST_MODEL, agentId: "exec", ...setup?.sendOptions },
    setup?.sendInternal
  );
  expect(sent.success).toBe(true);
  expect(streamMessage).toHaveBeenCalledTimes(1);
  expect(harness.session.isBusy()).toBe(true);
  // The tool step's committed assistant row: the row the model never answered when stranded.
  await harness.historyService.appendToHistory(
    workspaceId,
    createMuxMessage("assistant-1", "assistant", "ran the checks", { timestamp: Date.now() })
  );

  /** Queue a synthetic wake whose cancel signal the caller controls. */
  const queueCancelableWake = (): AbortController => {
    const controller = new AbortController();
    harness.session.queueMessage(
      "Background monitor wake",
      { model: TEST_MODEL, agentId: "exec" },
      {
        synthetic: true,
        agentInitiated: true,
        cancelState: { canceledBeforeAcceptance: false },
        cancelSignal: controller.signal,
        onCanceled: () => undefined,
      }
    );
    return controller;
  };
  const latestRequest = (): StreamMessageOptions => {
    const call = streamMessage.mock.calls[streamMessage.mock.calls.length - 1];
    if (call == null) {
      throw new Error("no streamMessage call recorded");
    }
    return call[0];
  };

  return { ...harness, streamMessage, queueCancelableWake, latestRequest };
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
      return Promise.resolve(Ok(createStartedTurnHandle()));
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

  test("getQueueCutCutter reports an engaged no-metadata dispatch over a queued follow-up", async () => {
    // Queue-cut attribution must never blame an entry queued BEHIND the input
    // actually taking over the session: a manual message being dispatched wins
    // over a workspace-turn follow-up waiting behind it, even though its
    // metadata is undefined.
    const { session, cleanup } = await createAgentSessionHarness({
      workspaceId: "queue-cut-cutter-preparing",
    });

    try {
      expect(session.getQueueCutCutter()).toBeUndefined();

      session.queueMessage(
        "manual message",
        { model: TEST_MODEL, agentId: "exec" },
        { synthetic: true }
      );
      session.queueMessage(
        "workspace-turn follow-up",
        { model: TEST_MODEL, agentId: "exec", muxMetadata: WORKSPACE_TURN_CORRELATION },
        { synthetic: true }
      );

      // Queued stage: the manual head entry is the candidate (no metadata).
      const queued = session.getQueueCutCutter();
      expect(queued?.stage).toBe("queued");
      expect(queued?.muxMetadata).toBeUndefined();

      // Dispatch the manual entry: it becomes the engaged PREPARING cutter and
      // keeps winning over the follow-up still queued behind it.
      const sendMessage = spyOn(session, "sendMessage").mockResolvedValue(Ok(undefined));
      session.sendQueuedMessages();
      const engaged = session.getQueueCutCutter();
      expect(engaged?.stage).toBe("preparing");
      expect(engaged?.muxMetadata).toBeUndefined();
      sendMessage.mockRestore();
    } finally {
      session.dispose();
      await cleanup();
    }
  });

  test("getQueueCutCutter reports a no-metadata mid-dispatch entry over a queued follow-up", async () => {
    const { session, cleanup } = await createAgentSessionHarness({
      workspaceId: "queue-cut-cutter-dispatching",
    });

    try {
      session.queueMessage(
        "workspace-turn follow-up",
        { model: TEST_MODEL, agentId: "exec", muxMetadata: WORKSPACE_TURN_CORRELATION },
        { synthetic: true }
      );
      // Force the dequeue-to-stream-start window with PREPARING already
      // released (a background send can resolve before stream-start): the
      // dispatched entry stays the engaged cutter.
      const internal = session as unknown as {
        dispatchingQueuedEntry: boolean;
        dispatchingQueuedEntryMuxMetadata?: unknown;
      };
      internal.dispatchingQueuedEntry = true;
      internal.dispatchingQueuedEntryMuxMetadata = undefined;

      const cutter = session.getQueueCutCutter();
      expect(cutter?.stage).toBe("dispatching");
      expect(cutter?.muxMetadata).toBeUndefined();
    } finally {
      session.dispose();
      await cleanup();
    }
  });

  test("getQueueCutCutter exposes the queued head's dispatch mode and correlation", async () => {
    const { session, cleanup } = await createAgentSessionHarness({
      workspaceId: "queue-cut-cutter-queued",
    });

    try {
      session.queueMessage(
        "workspace-turn follow-up",
        {
          model: TEST_MODEL,
          agentId: "exec",
          muxMetadata: WORKSPACE_TURN_CORRELATION,
          queueDispatchMode: "turn-end",
        },
        { synthetic: true }
      );

      const cutter = session.getQueueCutCutter();
      expect(cutter?.stage).toBe("queued");
      expect(cutter?.stage === "queued" ? cutter.dispatchMode : undefined).toBe("turn-end");
      expect((cutter?.muxMetadata as MuxMessageMetadata | undefined)?.type).toBe(
        "workspace-turn-task"
      );

      // Once dispatched, the follow-up's correlation rides through PREPARING.
      const sendMessage = spyOn(session, "sendMessage").mockResolvedValue(Ok(undefined));
      session.sendQueuedMessages();
      const engaged = session.getQueueCutCutter();
      expect(engaged?.stage).toBe("preparing");
      expect((engaged?.muxMetadata as MuxMessageMetadata | undefined)?.type).toBe(
        "workspace-turn-task"
      );
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
        abortReason: "queued-message",
      });

      aiEmitter.emit("stream-abort", streamAbortEvent(workspaceId, "queued-message"));
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

  test("resumes a turn whose queued tool-end stop message is withdrawn before acceptance", async () => {
    const workspaceId = "queue-dispatch-stranded-resume";
    const harness = await createStreamingTurnHarness(workspaceId);
    const { session, cleanup, aiEmitter, historyService, streamMessage } = harness;

    try {
      const wake = harness.queueCancelableWake();
      const request = harness.latestRequest();
      expect(request.hasQueuedMessages?.("tool-end")).toBe(true);
      // StreamManager stopped the loop for the queued wake; the wake is then withdrawn
      // (its output was consumed another way) before the stream-end drain dispatches it.
      request.onQueuedMessageStop?.({ modelString: TEST_MODEL });
      wake.abort("monitor consumed");
      aiEmitter.emit("stream-end", streamEndEvent(workspaceId));

      expect(await waitForCondition(() => streamMessage.mock.calls.length === 2)).toBe(true);
      const resumed = harness.latestRequest();
      // The continuation keeps the interrupted (user-started) turn's attribution.
      expect(resumed.agentInitiated).toBe(streamMessage.mock.calls[0]?.[0].agentInitiated);
      expect(resumed.modelString).toBe(TEST_MODEL);
      expect(resumed.agentId).toBe("exec");
      // The resumed request ends with a user turn so the model has something to answer.
      expect(resumed.messages[resumed.messages.length - 1]?.role).toBe("user");
      expect(session.isBusy()).toBe(true);
      expect(session.hasQueuedMessages()).toBe(false);

      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(streamMessage).toHaveBeenCalledTimes(2);
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
      session.dispose();
      await cleanup();
    }
  });

  test("a queued tool-end message that dispatches normally is the continuation", async () => {
    const workspaceId = "queue-dispatch-stranded-dispatched";
    const harness = await createStreamingTurnHarness(workspaceId);
    const { session, cleanup, aiEmitter, streamMessage } = harness;

    try {
      harness.queueCancelableWake();
      harness.latestRequest().onQueuedMessageStop?.({ modelString: TEST_MODEL });
      aiEmitter.emit("stream-end", streamEndEvent(workspaceId));

      expect(await waitForCondition(() => streamMessage.mock.calls.length === 2)).toBe(true);
      const dispatched = harness.latestRequest();
      const lastMessage = dispatched.messages[dispatched.messages.length - 1];
      expect(lastMessage?.role).toBe("user");
      expect(
        lastMessage?.parts.some(
          (part) => part.type === "text" && part.text === "Background monitor wake"
        )
      ).toBe(true);
      expect(session.isBusy()).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(streamMessage).toHaveBeenCalledTimes(2);
    } finally {
      session.dispose();
      await cleanup();
    }
  });

  test("does not resume when the loop ended without stopping for a queued message", async () => {
    const workspaceId = "queue-dispatch-stranded-not-stopped";
    const harness = await createStreamingTurnHarness(workspaceId);
    const { session, cleanup, aiEmitter, streamMessage } = harness;

    try {
      // A required tool (agent_report) ended the turn while a wake happened to be queued.
      const wake = harness.queueCancelableWake();
      wake.abort("monitor consumed");
      aiEmitter.emit("stream-end", streamEndEvent(workspaceId));

      expect(await waitForCondition(() => !session.isBusy())).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(streamMessage).toHaveBeenCalledTimes(1);
      expect(session.isBusy()).toBe(false);
    } finally {
      session.dispose();
      await cleanup();
    }
  });

  test("a turn stranded after each of several awaited monitors resumes every time", async () => {
    const workspaceId = "queue-dispatch-stranded-chain";
    const harness = await createStreamingTurnHarness(workspaceId);
    const { session, cleanup, aiEmitter, streamMessage } = harness;

    try {
      // Each cut follows a completed step whose task_await consumed the monitor's wake (dogfood
      // UAT: four sequential background+await calls in one prompt); the cap must not end it.
      const strandTurn = () => {
        harness.latestRequest().onQueuedMessageStop?.({ modelString: TEST_MODEL });
        harness.queueCancelableWake().abort("monitor consumed");
        aiEmitter.emit("stream-end", streamEndEvent(workspaceId));
      };

      for (let resumes = 1; resumes <= 4; resumes += 1) {
        strandTurn();
        expect(await waitForCondition(() => streamMessage.mock.calls.length === resumes + 1)).toBe(
          true
        );
        expect(session.isBusy()).toBe(true);
      }
    } finally {
      session.dispose();
      await cleanup();
    }
  });

  test("caps resume attempts that never start a stream", async () => {
    const workspaceId = "queue-dispatch-stranded-cap";
    let gateOpen = true;
    const pricingGate = mock(() =>
      Promise.resolve(gateOpen ? Ok(undefined) : Err({ type: "unknown", raw: "gate closed" }))
    );
    const workspaceGoalService = {
      assertPricedModelForBudgetedGoal: pricingGate,
      recordStreamAccounting: mock(() => Promise.resolve()),
      applyPendingAfterStreamEnd: mock(() => Promise.resolve()),
      requestContinuationAfterStreamEnd: mock(() => Promise.resolve()),
      recordStreamStarted: mock(() => Promise.resolve()),
      syncGoalModeWithChatTail: mock(() => Promise.resolve(null)),
    } as unknown as WorkspaceGoalService;
    const harness = await createStreamingTurnHarness(workspaceId, {
      harness: { workspaceGoalService },
      sendInternal: { synthetic: true, agentInitiated: true },
    });
    const { session, cleanup, aiEmitter, streamMessage } = harness;

    try {
      gateOpen = false;
      const wake = harness.queueCancelableWake();
      harness.latestRequest().onQueuedMessageStop?.({ modelString: TEST_MODEL });
      wake.abort("monitor consumed");
      aiEmitter.emit("stream-end", streamEndEvent(workspaceId));
      expect(await waitForCondition(() => !session.isBusy())).toBe(true);
      const attemptsBefore = pricingGate.mock.calls.length;

      // Each idle poke retries the failing resume until the cap, then the marker is dropped and
      // further pokes do nothing.
      for (let poke = 1; poke <= 4; poke += 1) {
        session.drainQueuedMessagesIfIdle();
        expect(await waitForCondition(() => !session.isBusy())).toBe(true);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(pricingGate.mock.calls.length - attemptsBefore).toBe(2);
      expect(streamMessage).toHaveBeenCalledTimes(1);

      gateOpen = true;
      session.drainQueuedMessagesIfIdle();
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(streamMessage).toHaveBeenCalledTimes(1);
    } finally {
      session.dispose();
      await cleanup();
    }
  });

  test("resumes after a provider-tool soft stop whose queued message was withdrawn", async () => {
    const workspaceId = "queue-dispatch-stranded-provider-tool";
    const harness = await createStreamingTurnHarness(workspaceId);
    const { session, cleanup, aiEmitter, aiService, streamMessage } = harness;
    const stopStream = spyOn(aiService, "stopStream").mockResolvedValue(Ok(undefined));

    try {
      session.queueMessage(
        "follow up",
        { model: TEST_MODEL, agentId: "exec" },
        { synthetic: true, dedupeKey: "wake:1" }
      );
      aiEmitter.emit("tool-call-end", {
        ...toolCallEndEvent(workspaceId),
        toolName: "web_search",
        providerExecuted: true,
      });
      expect(stopStream).toHaveBeenCalledTimes(1);

      // Withdrawn between the soft stop request and the abort it produces.
      expect(session.removeQueuedMessagesByDedupeKeyPrefix("wake:", "superseded")).toBe(1);
      aiEmitter.emit("stream-abort", streamAbortEvent(workspaceId, "queued-message"));

      expect(await waitForCondition(() => streamMessage.mock.calls.length === 2)).toBe(true);
      expect(harness.latestRequest().agentInitiated).toBe(
        streamMessage.mock.calls[0]?.[0].agentInitiated
      );
      expect(session.isBusy()).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(streamMessage).toHaveBeenCalledTimes(2);
    } finally {
      stopStream.mockRestore();
      session.dispose();
      await cleanup();
    }
  });

  test("owes the delegated turn its continuation from the stop decision onward", async () => {
    const workspaceId = "queue-dispatch-stranded-delegated";
    const harness = await createStreamingTurnHarness(workspaceId, {
      sendOptions: { muxMetadata: WORKSPACE_TURN_CORRELATION },
    });
    const { session, cleanup, aiEmitter, streamMessage } = harness;

    try {
      // Nothing owed yet: a tool-calls cut with an empty queue is a plain interruption.
      expect(session.hasPendingWorkspaceTurnContinuation(WORKSPACE_TURN_CORRELATION)).toBe(false);

      const wake = harness.queueCancelableWake();
      harness.latestRequest().onQueuedMessageStop?.({ modelString: TEST_MODEL });
      // The entry is gone before the stream ends (dedupe removal / clearQueue shape).
      wake.abort("monitor consumed");
      session.clearQueue("monitor consumed");

      // The owner's settlement runs synchronously with stream-end; it must already see the
      // continuation, and only for this correlation.
      expect(session.hasPendingWorkspaceTurnContinuation(WORKSPACE_TURN_CORRELATION)).toBe(true);
      expect(
        session.hasPendingWorkspaceTurnContinuation({
          ...WORKSPACE_TURN_CORRELATION,
          turnId: "another-turn",
        })
      ).toBe(false);

      aiEmitter.emit("stream-end", streamEndEvent(workspaceId));
      expect(await waitForCondition(() => streamMessage.mock.calls.length === 2)).toBe(true);
      expect(harness.latestRequest().muxMetadata).toEqual(WORKSPACE_TURN_CORRELATION);
      // Consumed by the resumed stream.
      expect(session.hasPendingWorkspaceTurnContinuation(WORKSPACE_TURN_CORRELATION)).toBe(false);
    } finally {
      session.dispose();
      await cleanup();
    }
  });

  test("a queued unrelated entry supersedes the delegated turn despite the owed continuation", async () => {
    const workspaceId = "queue-dispatch-stranded-delegated-superseded";
    const harness = await createStreamingTurnHarness(workspaceId, {
      sendOptions: { muxMetadata: WORKSPACE_TURN_CORRELATION },
    });
    const { session, cleanup } = harness;

    try {
      harness.latestRequest().onQueuedMessageStop?.({ modelString: TEST_MODEL });
      session.queueMessage("user follow-up", { model: TEST_MODEL, agentId: "exec" });
      expect(session.hasPendingWorkspaceTurnContinuation(WORKSPACE_TURN_CORRELATION)).toBe(false);
    } finally {
      session.dispose();
      await cleanup();
    }
  });

  test("a wake-started continuation resumes with the correlation it inherited from history", async () => {
    const workspaceId = "queue-dispatch-stranded-inherited-correlation";
    const wakeMetadata: MuxMessageMetadata = {
      type: "bash-monitor-wake",
      records: [
        {
          processId: "proc-1",
          wakeUpdatedAt: "2026-01-01T00:00:00.000Z",
          kind: "match",
          displayName: "marker",
          filter: "MARKER",
          filterExclude: false,
        },
      ],
    };
    const harness = await createStreamingTurnHarness(workspaceId, {
      seedHistory: async (historyService) => {
        // The delegated turn's stream was cut at a tool boundary by the first wake.
        await historyService.appendToHistory(
          workspaceId,
          createMuxMessage("user-0", "user", "delegated prompt", {
            timestamp: Date.now(),
            muxMetadata: WORKSPACE_TURN_CORRELATION,
          })
        );
        await historyService.appendToHistory(
          workspaceId,
          createMuxMessage("assistant-0", "assistant", "working", {
            timestamp: Date.now(),
            finishReason: "tool-calls",
            muxMetadata: WORKSPACE_TURN_CORRELATION,
          })
        );
      },
      sendOptions: { muxMetadata: wakeMetadata },
      sendInternal: { synthetic: true, agentInitiated: true },
    });
    const { session, cleanup, aiEmitter, streamMessage } = harness;

    try {
      const wake = harness.queueCancelableWake();
      harness.latestRequest().onQueuedMessageStop?.({ modelString: TEST_MODEL });
      wake.abort("monitor consumed");
      expect(session.hasPendingWorkspaceTurnContinuation(WORKSPACE_TURN_CORRELATION)).toBe(false);
      session.clearQueue("monitor consumed");
      expect(session.hasPendingWorkspaceTurnContinuation(WORKSPACE_TURN_CORRELATION)).toBe(true);

      aiEmitter.emit("stream-end", streamEndEvent(workspaceId));
      expect(await waitForCondition(() => streamMessage.mock.calls.length === 2)).toBe(true);
      expect(harness.latestRequest().muxMetadata).toEqual(WORKSPACE_TURN_CORRELATION);
    } finally {
      session.dispose();
      await cleanup();
    }
  });

  test("yields the stranded resume to a manual send in preflight", async () => {
    const workspaceId = "queue-dispatch-stranded-preflight";
    let preflightInFlight = true;
    const harness = await createStreamingTurnHarness(workspaceId, {
      harness: { hasExternalSendPreflight: () => preflightInFlight },
    });
    const { session, cleanup, aiEmitter, streamMessage } = harness;

    try {
      const wake = harness.queueCancelableWake();
      harness.latestRequest().onQueuedMessageStop?.({ modelString: TEST_MODEL });
      wake.abort("monitor consumed");
      aiEmitter.emit("stream-end", streamEndEvent(workspaceId));

      expect(await waitForCondition(() => !session.isBusy())).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(streamMessage).toHaveBeenCalledTimes(1);

      // The preflight settled without a turn; its idle drain delivers the owed continuation.
      preflightInFlight = false;
      session.drainQueuedMessagesIfIdle();
      expect(await waitForCondition(() => streamMessage.mock.calls.length === 2)).toBe(true);
    } finally {
      session.dispose();
      await cleanup();
    }
  });

  test("keeps the continuation owed when the resume fails before its stream starts", async () => {
    const workspaceId = "queue-dispatch-stranded-retry";
    let gateOpen = false;
    const workspaceGoalService = {
      assertPricedModelForBudgetedGoal: mock(() =>
        Promise.resolve(gateOpen ? Ok(undefined) : Err({ type: "unknown", raw: "gate closed" }))
      ),
      recordStreamAccounting: mock(() => Promise.resolve()),
      applyPendingAfterStreamEnd: mock(() => Promise.resolve()),
      requestContinuationAfterStreamEnd: mock(() => Promise.resolve()),
      recordStreamStarted: mock(() => Promise.resolve()),
      syncGoalModeWithChatTail: mock(() => Promise.resolve(null)),
    } as unknown as WorkspaceGoalService;
    // The gate is closed for the resume only: the initial send passes while it is open.
    gateOpen = true;
    const harness = await createStreamingTurnHarness(workspaceId, {
      harness: { workspaceGoalService },
      sendInternal: { synthetic: true, agentInitiated: true },
    });
    const { session, cleanup, aiEmitter, streamMessage } = harness;

    try {
      gateOpen = false;
      const wake = harness.queueCancelableWake();
      harness.latestRequest().onQueuedMessageStop?.({ modelString: TEST_MODEL });
      wake.abort("monitor consumed");
      aiEmitter.emit("stream-end", streamEndEvent(workspaceId));

      expect(await waitForCondition(() => !session.isBusy())).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(streamMessage).toHaveBeenCalledTimes(1);

      gateOpen = true;
      session.drainQueuedMessagesIfIdle();
      expect(await waitForCondition(() => streamMessage.mock.calls.length === 2)).toBe(true);
    } finally {
      session.dispose();
      await cleanup();
    }
  });

  test("a stranded goal continuation resumes under the same goal attribution", async () => {
    const workspaceId = "queue-dispatch-stranded-goal";
    const recordStreamAccounting = mock((_input: { streamOriginKind: string }) =>
      Promise.resolve()
    );
    const buildGoalRedispatchAdmission = mock(() =>
      Promise.resolve({ admissible: true as const, admissionStale: () => false })
    );
    const workspaceGoalService = {
      assertPricedModelForBudgetedGoal: mock(() => Promise.resolve(Ok(undefined))),
      buildGoalRedispatchAdmission,
      recordStreamAccounting,
      applyPendingAfterStreamEnd: mock(() => Promise.resolve()),
      requestContinuationAfterStreamEnd: mock(() => Promise.resolve()),
      recordStreamStarted: mock(() => Promise.resolve()),
      syncGoalModeWithChatTail: mock(() => Promise.resolve(null)),
      completeGoalFromSilentContinuation: mock(() => Promise.resolve(false)),
    } as unknown as WorkspaceGoalService;
    const aiEmitter = new EventEmitter();
    const streamMessage = mock((_options: StreamMessageOptions) => {
      aiEmitter.emit("stream-start", streamStartEvent(workspaceId));
      return Promise.resolve(Ok(createStartedTurnHandle("assistant-1")));
    });
    const { session, cleanup, historyService } = await createAgentSessionHarness({
      workspaceId,
      aiEmitter,
      aiServiceOverrides: { streamMessage: streamMessage as unknown as AIService["streamMessage"] },
      workspaceGoalService,
    });

    try {
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("user-0", "user", "keep going", { timestamp: Date.now() })
      );
      const resumed = await session.resumeStream(
        { model: TEST_MODEL, agentId: "exec" },
        { agentInitiated: true, goalKind: GOAL_CONTINUATION_KIND, goalId: "goal-1" }
      );
      expect(resumed.success).toBe(true);
      expect(streamMessage).toHaveBeenCalledTimes(1);
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("assistant-1", "assistant", "ran the checks", { timestamp: Date.now() })
      );

      const controller = new AbortController();
      session.queueMessage(
        "Background monitor wake",
        { model: TEST_MODEL, agentId: "exec" },
        {
          synthetic: true,
          agentInitiated: true,
          cancelState: { canceledBeforeAcceptance: false },
          cancelSignal: controller.signal,
          onCanceled: () => undefined,
        }
      );
      streamMessage.mock.calls[0]?.[0].onQueuedMessageStop?.({ modelString: TEST_MODEL });
      controller.abort("monitor consumed");
      aiEmitter.emit("stream-end", streamEndEvent(workspaceId));
      expect(await waitForCondition(() => streamMessage.mock.calls.length === 2)).toBe(true);

      // The resumed stream's own end is accounted as the same goal continuation.
      aiEmitter.emit("stream-end", { ...streamEndEvent(workspaceId), messageId: "assistant-2" });
      expect(await waitForCondition(() => recordStreamAccounting.mock.calls.length === 2)).toBe(
        true
      );
      expect(recordStreamAccounting.mock.calls.map((call) => call[0].streamOriginKind)).toEqual([
        "goal_continuation",
        "goal_continuation",
      ]);
      // Resumed under the goal's own admission, like any redispatched goal turn.
      expect(buildGoalRedispatchAdmission).toHaveBeenCalledWith(
        workspaceId,
        "goal-1",
        GOAL_CONTINUATION_KIND
      );
    } finally {
      session.dispose();
      await cleanup();
    }
  });

  test("drops a stranded goal continuation the goal no longer admits", async () => {
    const workspaceId = "queue-dispatch-stranded-goal-paused";
    const workspaceGoalService = {
      assertPricedModelForBudgetedGoal: mock(() => Promise.resolve(Ok(undefined))),
      // The user paused the goal while the turn ran; the pause landed at stream end.
      buildGoalRedispatchAdmission: mock(() => Promise.resolve({ admissible: false as const })),
      recordStreamAccounting: mock(() => Promise.resolve()),
      applyPendingAfterStreamEnd: mock(() => Promise.resolve()),
      requestContinuationAfterStreamEnd: mock(() => Promise.resolve()),
      recordStreamStarted: mock(() => Promise.resolve()),
      syncGoalModeWithChatTail: mock(() => Promise.resolve(null)),
      completeGoalFromSilentContinuation: mock(() => Promise.resolve(false)),
    } as unknown as WorkspaceGoalService;
    const aiEmitter = new EventEmitter();
    const streamMessage = mock((_options: StreamMessageOptions) => {
      aiEmitter.emit("stream-start", streamStartEvent(workspaceId));
      return Promise.resolve(Ok(createStartedTurnHandle("assistant-1")));
    });
    const { session, cleanup, historyService } = await createAgentSessionHarness({
      workspaceId,
      aiEmitter,
      aiServiceOverrides: { streamMessage: streamMessage as unknown as AIService["streamMessage"] },
      workspaceGoalService,
    });

    try {
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("user-0", "user", "keep going", { timestamp: Date.now() })
      );
      const resumed = await session.resumeStream(
        { model: TEST_MODEL, agentId: "exec" },
        { agentInitiated: true, goalKind: GOAL_CONTINUATION_KIND, goalId: "goal-1" }
      );
      expect(resumed.success).toBe(true);
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("assistant-1", "assistant", "ran the checks", { timestamp: Date.now() })
      );

      const controller = new AbortController();
      session.queueMessage(
        "Background monitor wake",
        { model: TEST_MODEL, agentId: "exec" },
        {
          synthetic: true,
          agentInitiated: true,
          cancelState: { canceledBeforeAcceptance: false },
          cancelSignal: controller.signal,
          onCanceled: () => undefined,
        }
      );
      streamMessage.mock.calls[0]?.[0].onQueuedMessageStop?.({ modelString: TEST_MODEL });
      controller.abort("monitor consumed");
      aiEmitter.emit("stream-end", streamEndEvent(workspaceId));

      expect(await waitForCondition(() => !session.isBusy())).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(streamMessage).toHaveBeenCalledTimes(1);
      // Forfeited, not deferred: a later idle poke must not revive the paused goal's turn.
      session.drainQueuedMessagesIfIdle();
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(streamMessage).toHaveBeenCalledTimes(1);
      expect(session.isBusy()).toBe(false);
    } finally {
      session.dispose();
      await cleanup();
    }
  });

  test("a user Stop withdraws the owed continuation", async () => {
    const workspaceId = "queue-dispatch-stranded-user-stop";
    const harness = await createStreamingTurnHarness(workspaceId);
    const { session, cleanup, aiEmitter, streamMessage } = harness;

    try {
      harness.queueCancelableWake();
      harness.latestRequest().onQueuedMessageStop?.({ modelString: TEST_MODEL });
      // WorkspaceService.interruptStream: hard stop, then restore the queue to the composer.
      expect((await session.interruptStream()).success).toBe(true);
      aiEmitter.emit("stream-abort", streamAbortEvent(workspaceId, "user"));
      expect(await waitForCondition(() => !session.isBusy())).toBe(true);
      session.restoreQueueToInput();

      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(streamMessage).toHaveBeenCalledTimes(1);
      expect(session.isBusy()).toBe(false);
      expect(session.hasQueuedMessages()).toBe(false);
    } finally {
      session.dispose();
      await cleanup();
    }
  });

  test("the resume holds the turn while its admission gates run", async () => {
    const workspaceId = "queue-dispatch-stranded-claims-turn";
    let releaseGate: () => void = () => undefined;
    let gateArmed = false;
    let gateReached = false;
    const workspaceGoalService = {
      assertPricedModelForBudgetedGoal: mock(() => {
        if (!gateArmed) {
          return Promise.resolve(Ok(undefined));
        }
        gateReached = true;
        return new Promise((resolve) => {
          releaseGate = () => resolve(Ok(undefined));
        });
      }),
      recordStreamAccounting: mock(() => Promise.resolve()),
      applyPendingAfterStreamEnd: mock(() => Promise.resolve()),
      requestContinuationAfterStreamEnd: mock(() => Promise.resolve()),
      recordStreamStarted: mock(() => Promise.resolve()),
      syncGoalModeWithChatTail: mock(() => Promise.resolve(null)),
    } as unknown as WorkspaceGoalService;
    const harness = await createStreamingTurnHarness(workspaceId, {
      harness: { workspaceGoalService },
      sendInternal: { synthetic: true, agentInitiated: true },
    });
    const { session, cleanup, aiEmitter, streamMessage } = harness;

    try {
      gateArmed = true;
      const wake = harness.queueCancelableWake();
      harness.latestRequest().onQueuedMessageStop?.({ modelString: TEST_MODEL });
      wake.abort("monitor consumed");
      aiEmitter.emit("stream-end", streamEndEvent(workspaceId));

      // The resume is parked on the pricing gate: the session must already read busy so a
      // manual send arriving now queues behind it instead of starting a colliding stream.
      expect(await waitForCondition(() => gateReached)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(streamMessage).toHaveBeenCalledTimes(1);
      expect(session.isBusy()).toBe(true);

      releaseGate();
      expect(await waitForCondition(() => streamMessage.mock.calls.length === 2)).toBe(true);
    } finally {
      session.dispose();
      await cleanup();
    }
  });

  test("the resume drops the interrupted turn's ACP prompt binding", async () => {
    const workspaceId = "queue-dispatch-stranded-acp";
    const harness = await createStreamingTurnHarness(workspaceId, {
      sendOptions: { acpPromptId: "prompt-1", delegatedToolNames: ["bash"] },
    });
    const { session, cleanup, aiEmitter, streamMessage } = harness;

    try {
      const original = harness.latestRequest();
      expect(original.acpPromptId).toBe("prompt-1");
      expect(original.delegatedToolNames).toEqual(["bash"]);

      const wake = harness.queueCancelableWake();
      original.onQueuedMessageStop?.({ modelString: TEST_MODEL });
      wake.abort("monitor consumed");
      aiEmitter.emit("stream-end", streamEndEvent(workspaceId));

      expect(await waitForCondition(() => streamMessage.mock.calls.length === 2)).toBe(true);
      const resumed = harness.latestRequest();
      expect(resumed.modelString).toBe(TEST_MODEL);
      // The ACP turn completed at the first stream-end; a delegated tool call on the resumed
      // stream would otherwise wait on a prompt nobody answers.
      expect(resumed.acpPromptId).toBeUndefined();
      expect(resumed.delegatedToolNames).toBeUndefined();
    } finally {
      session.dispose();
      await cleanup();
    }
  });

  test("stops advertising the delegated continuation once the resume cap is exhausted", async () => {
    const workspaceId = "queue-dispatch-stranded-delegated-cap";
    let gateOpen = true;
    const workspaceGoalService = {
      assertPricedModelForBudgetedGoal: mock(() =>
        Promise.resolve(gateOpen ? Ok(undefined) : Err({ type: "unknown", raw: "gate closed" }))
      ),
      recordStreamAccounting: mock(() => Promise.resolve()),
      applyPendingAfterStreamEnd: mock(() => Promise.resolve()),
      requestContinuationAfterStreamEnd: mock(() => Promise.resolve()),
      recordStreamStarted: mock(() => Promise.resolve()),
      syncGoalModeWithChatTail: mock(() => Promise.resolve(null)),
    } as unknown as WorkspaceGoalService;
    const harness = await createStreamingTurnHarness(workspaceId, {
      harness: { workspaceGoalService },
      sendOptions: { muxMetadata: WORKSPACE_TURN_CORRELATION },
      sendInternal: { synthetic: true, agentInitiated: true },
    });
    const { session, cleanup, aiEmitter, streamMessage } = harness;

    try {
      gateOpen = false;
      harness.latestRequest().onQueuedMessageStop?.({ modelString: TEST_MODEL });
      harness.queueCancelableWake().abort("monitor consumed");
      session.clearQueue("monitor consumed");
      expect(session.hasPendingWorkspaceTurnContinuation(WORKSPACE_TURN_CORRELATION)).toBe(true);
      aiEmitter.emit("stream-end", streamEndEvent(workspaceId));
      expect(await waitForCondition(() => !session.isBusy())).toBe(true);

      // The resume keeps failing before its stream starts; while attempts remain the owner
      // defers settlement, and once the cap is exhausted the continuation is no longer
      // advertised so the owner settles the turn at the cut.
      session.drainQueuedMessagesIfIdle();
      expect(await waitForCondition(() => !session.isBusy())).toBe(true);
      expect(session.hasPendingWorkspaceTurnContinuation(WORKSPACE_TURN_CORRELATION)).toBe(true);
      session.drainQueuedMessagesIfIdle();
      expect(await waitForCondition(() => !session.isBusy())).toBe(true);
      expect(session.hasPendingWorkspaceTurnContinuation(WORKSPACE_TURN_CORRELATION)).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(streamMessage).toHaveBeenCalledTimes(1);
    } finally {
      session.dispose();
      await cleanup();
    }
  });

  test("a user Stop during the resume's admission gate cancels it", async () => {
    const workspaceId = "queue-dispatch-stranded-stop-in-admission";
    let releaseGate: () => void = () => undefined;
    let gateArmed = false;
    let gateReached = false;
    const workspaceGoalService = {
      assertPricedModelForBudgetedGoal: mock(() => {
        if (!gateArmed) {
          return Promise.resolve(Ok(undefined));
        }
        gateReached = true;
        return new Promise((resolve) => {
          releaseGate = () => resolve(Ok(undefined));
        });
      }),
      recordStreamAccounting: mock(() => Promise.resolve()),
      applyPendingAfterStreamEnd: mock(() => Promise.resolve()),
      requestContinuationAfterStreamEnd: mock(() => Promise.resolve()),
      recordStreamStarted: mock(() => Promise.resolve()),
      syncGoalModeWithChatTail: mock(() => Promise.resolve(null)),
    } as unknown as WorkspaceGoalService;
    const harness = await createStreamingTurnHarness(workspaceId, {
      harness: { workspaceGoalService },
      sendInternal: { synthetic: true, agentInitiated: true },
    });
    const { session, cleanup, aiEmitter, streamMessage } = harness;

    try {
      gateArmed = true;
      const wake = harness.queueCancelableWake();
      harness.latestRequest().onQueuedMessageStop?.({ modelString: TEST_MODEL });
      wake.abort("monitor consumed");
      aiEmitter.emit("stream-end", streamEndEvent(workspaceId));
      expect(await waitForCondition(() => gateReached)).toBe(true);

      // Stop lands while the claimed resume is parked on its gate: StreamManager has no stream
      // to abort, so the resume itself must not proceed once the gate opens.
      expect((await session.interruptStream()).success).toBe(true);
      releaseGate();

      expect(await waitForCondition(() => !session.isBusy())).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(streamMessage).toHaveBeenCalledTimes(1);
      expect(session.isBusy()).toBe(false);
    } finally {
      session.dispose();
      await cleanup();
    }
  });

  test("a goal transition between admission and launch drops the resume", async () => {
    const workspaceId = "queue-dispatch-stranded-goal-stale";
    const workspaceGoalService = {
      assertPricedModelForBudgetedGoal: mock(() => Promise.resolve(Ok(undefined))),
      // Admitted on read, but the pause generation moved before the stream could launch.
      buildGoalRedispatchAdmission: mock(() =>
        Promise.resolve({ admissible: true as const, admissionStale: () => true })
      ),
      recordStreamAccounting: mock(() => Promise.resolve()),
      applyPendingAfterStreamEnd: mock(() => Promise.resolve()),
      requestContinuationAfterStreamEnd: mock(() => Promise.resolve()),
      recordStreamStarted: mock(() => Promise.resolve()),
      syncGoalModeWithChatTail: mock(() => Promise.resolve(null)),
      completeGoalFromSilentContinuation: mock(() => Promise.resolve(false)),
    } as unknown as WorkspaceGoalService;
    const aiEmitter = new EventEmitter();
    const streamMessage = mock((_options: StreamMessageOptions) => {
      aiEmitter.emit("stream-start", streamStartEvent(workspaceId));
      return Promise.resolve(Ok(createStartedTurnHandle("assistant-1")));
    });
    const { session, cleanup, historyService } = await createAgentSessionHarness({
      workspaceId,
      aiEmitter,
      aiServiceOverrides: { streamMessage: streamMessage as unknown as AIService["streamMessage"] },
      workspaceGoalService,
    });

    try {
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("user-0", "user", "keep going", { timestamp: Date.now() })
      );
      const resumed = await session.resumeStream(
        { model: TEST_MODEL, agentId: "exec" },
        { agentInitiated: true, goalKind: GOAL_CONTINUATION_KIND, goalId: "goal-1" }
      );
      expect(resumed.success).toBe(true);
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("assistant-1", "assistant", "ran the checks", { timestamp: Date.now() })
      );

      const controller = new AbortController();
      session.queueMessage(
        "Background monitor wake",
        { model: TEST_MODEL, agentId: "exec" },
        {
          synthetic: true,
          agentInitiated: true,
          cancelState: { canceledBeforeAcceptance: false },
          cancelSignal: controller.signal,
          onCanceled: () => undefined,
        }
      );
      streamMessage.mock.calls[0]?.[0].onQueuedMessageStop?.({ modelString: TEST_MODEL });
      controller.abort("monitor consumed");
      aiEmitter.emit("stream-end", streamEndEvent(workspaceId));

      expect(await waitForCondition(() => !session.isBusy())).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(streamMessage).toHaveBeenCalledTimes(1);
      session.drainQueuedMessagesIfIdle();
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(streamMessage).toHaveBeenCalledTimes(1);
    } finally {
      session.dispose();
      await cleanup();
    }
  });

  test("an unrelated queued entry that never starts does not revive the superseded delegated turn", async () => {
    const workspaceId = "queue-dispatch-stranded-delegated-orphan";
    const harness = await createStreamingTurnHarness(workspaceId, {
      sendOptions: { muxMetadata: WORKSPACE_TURN_CORRELATION },
    });
    const { session, cleanup, aiEmitter, streamMessage } = harness;

    try {
      const wake = harness.queueCancelableWake();
      harness.latestRequest().onQueuedMessageStop?.({ modelString: TEST_MODEL });
      // The queued wake is not this turn's continuation: the owner settles the delegated turn.
      expect(session.hasPendingWorkspaceTurnContinuation(WORKSPACE_TURN_CORRELATION)).toBe(false);
      aiEmitter.emit("stream-end", streamEndEvent(workspaceId));
      // The wake is withdrawn after dequeue, before acceptance; the settled turn must stay cut.
      wake.abort("monitor consumed");

      expect(await waitForCondition(() => !session.isBusy())).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(streamMessage).toHaveBeenCalledTimes(1);
      expect(session.hasPendingWorkspaceTurnContinuation(WORKSPACE_TURN_CORRELATION)).toBe(false);
    } finally {
      session.dispose();
      await cleanup();
    }
  });

  test("a message queued behind a rejected resume drains", async () => {
    const workspaceId = "queue-dispatch-stranded-rejected-drain";
    let rejectGate: () => void = () => undefined;
    let gateArmed = false;
    let gateReached = false;
    const workspaceGoalService = {
      assertPricedModelForBudgetedGoal: mock(() => {
        if (!gateArmed) {
          return Promise.resolve(Ok(undefined));
        }
        gateReached = true;
        return new Promise((resolve) => {
          rejectGate = () => resolve(Err({ type: "unknown", raw: "gate closed" }));
        });
      }),
      recordStreamAccounting: mock(() => Promise.resolve()),
      applyPendingAfterStreamEnd: mock(() => Promise.resolve()),
      requestContinuationAfterStreamEnd: mock(() => Promise.resolve()),
      recordStreamStarted: mock(() => Promise.resolve()),
      syncGoalModeWithChatTail: mock(() => Promise.resolve(null)),
    } as unknown as WorkspaceGoalService;
    const harness = await createStreamingTurnHarness(workspaceId, {
      harness: { workspaceGoalService },
      sendInternal: { synthetic: true, agentInitiated: true },
    });
    const { session, cleanup, aiEmitter, streamMessage } = harness;

    try {
      gateArmed = true;
      const wake = harness.queueCancelableWake();
      harness.latestRequest().onQueuedMessageStop?.({ modelString: TEST_MODEL });
      wake.abort("monitor consumed");
      aiEmitter.emit("stream-end", streamEndEvent(workspaceId));
      expect(await waitForCondition(() => gateReached)).toBe(true);

      // WorkspaceService queues a send behind the busy (PREPARING) resume.
      session.queueMessage("hello", { model: TEST_MODEL, agentId: "exec" }, { synthetic: true });
      gateArmed = false;
      rejectGate();

      // The rejected resume has no stream end to drain the queue at; the message must not wait
      // for an unrelated later poke.
      expect(await waitForCondition(() => streamMessage.mock.calls.length === 2)).toBe(true);
      const dispatched = harness.latestRequest();
      const lastMessage = dispatched.messages[dispatched.messages.length - 1];
      expect(lastMessage?.parts.some((part) => part.type === "text" && part.text === "hello")).toBe(
        true
      );
    } finally {
      session.dispose();
      await cleanup();
    }
  });

  test("the resume continues on the model that reached the cut", async () => {
    const workspaceId = "queue-dispatch-stranded-fallback-model";
    const harness = await createStreamingTurnHarness(workspaceId);
    const { session, cleanup, aiEmitter, streamMessage } = harness;

    try {
      const wake = harness.queueCancelableWake();
      // StreamManager reports the request that was running at the stop: a configured fallback
      // model, not the refused primary this stream was sent with.
      harness.latestRequest().onQueuedMessageStop?.({ modelString: "anthropic:claude-opus-4-8" });
      wake.abort("monitor consumed");
      aiEmitter.emit("stream-end", streamEndEvent(workspaceId));

      expect(await waitForCondition(() => streamMessage.mock.calls.length === 2)).toBe(true);
      expect(harness.latestRequest().modelString).toBe("anthropic:claude-opus-4-8");
    } finally {
      session.dispose();
      await cleanup();
    }
  });

  test("a mid-turn thinking change carries into the resume", async () => {
    const workspaceId = "queue-dispatch-stranded-thinking";
    const harness = await createStreamingTurnHarness(workspaceId, {
      sendOptions: { thinkingLevel: "low" },
    });
    const { session, cleanup, aiEmitter, streamMessage } = harness;

    try {
      const original = harness.latestRequest();
      expect(original.thinkingLevel).toBe("low");
      // The user raised the level mid-turn and the loop applied it at a step boundary.
      const holder = original.activeTurnThinkingOverride;
      expect(holder).toBeDefined();
      if (holder != null) {
        holder.applied = "high";
      }

      const wake = harness.queueCancelableWake();
      original.onQueuedMessageStop?.({ modelString: TEST_MODEL });
      wake.abort("monitor consumed");
      aiEmitter.emit("stream-end", streamEndEvent(workspaceId));

      expect(await waitForCondition(() => streamMessage.mock.calls.length === 2)).toBe(true);
      expect(harness.latestRequest().thinkingLevel).toBe("high");
    } finally {
      session.dispose();
      await cleanup();
    }
  });

  test("a system hard stop during a pending provider-tool soft stop does not resume", async () => {
    const workspaceId = "queue-dispatch-stranded-hard-system-stop";
    const harness = await createStreamingTurnHarness(workspaceId);
    const { session, cleanup, aiEmitter, aiService, streamMessage } = harness;
    const stopStream = spyOn(aiService, "stopStream").mockResolvedValue(Ok(undefined));

    try {
      session.queueMessage(
        "follow up",
        { model: TEST_MODEL, agentId: "exec" },
        { synthetic: true, dedupeKey: "wake:1" }
      );
      aiEmitter.emit("tool-call-end", {
        ...toolCallEndEvent(workspaceId),
        toolName: "web_search",
        providerExecuted: true,
      });
      expect(stopStream).toHaveBeenCalledTimes(1);

      // task_stop / interrupt cascade: clears the queue and hard-stops through aiService directly,
      // bypassing interruptStream, while the soft stop is still pending.
      session.clearQueue("task stopped");
      aiEmitter.emit("stream-abort", streamAbortEvent(workspaceId, "system"));

      expect(await waitForCondition(() => !session.isBusy())).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(streamMessage).toHaveBeenCalledTimes(1);
      expect(session.isBusy()).toBe(false);
    } finally {
      stopStream.mockRestore();
      session.dispose();
      await cleanup();
    }
  });

  /**
   * Strand a turn whose resume parks on its first pre-stream I/O (commitPartial) until the
   * caller releases it, so an event can land while the resume is PREPARING with no stream
   * registered for StreamManager to abort.
   */
  async function strandWithResumeParkedInPreStreamIo(workspaceId: string) {
    const harness = await createStreamingTurnHarness(workspaceId, {
      sendInternal: { synthetic: true, agentInitiated: true },
    });
    const { historyService } = harness;
    const originalCommitPartial = historyService.commitPartial.bind(historyService);
    let releaseIo: () => void = () => undefined;
    let ioReached = false;
    const commitPartial = spyOn(historyService, "commitPartial").mockImplementation(
      async (...args) => {
        ioReached = true;
        await new Promise<void>((resolve) => {
          releaseIo = resolve;
        });
        return originalCommitPartial(...args);
      }
    );
    const wake = harness.queueCancelableWake();
    harness.latestRequest().onQueuedMessageStop?.({ modelString: TEST_MODEL });
    wake.abort("monitor consumed");
    harness.aiEmitter.emit("stream-end", streamEndEvent(workspaceId));
    expect(await waitForCondition(() => ioReached)).toBe(true);
    expect(harness.session.isBusy()).toBe(true);
    return {
      ...harness,
      releaseIo: () => releaseIo(),
      restore: () => commitPartial.mockRestore(),
    };
  }

  test("a goal transition during the resume's pre-stream I/O drops the resume", async () => {
    const workspaceId = "queue-dispatch-stranded-goal-stale-in-io";
    let stale = false;
    const workspaceGoalService = {
      assertPricedModelForBudgetedGoal: mock(() => Promise.resolve(Ok(undefined))),
      buildGoalRedispatchAdmission: mock(() =>
        Promise.resolve({ admissible: true as const, admissionStale: () => stale })
      ),
      recordStreamAccounting: mock(() => Promise.resolve()),
      applyPendingAfterStreamEnd: mock(() => Promise.resolve()),
      requestContinuationAfterStreamEnd: mock(() => Promise.resolve()),
      recordStreamStarted: mock(() => Promise.resolve()),
      syncGoalModeWithChatTail: mock(() => Promise.resolve(null)),
      completeGoalFromSilentContinuation: mock(() => Promise.resolve(false)),
    } as unknown as WorkspaceGoalService;
    const aiEmitter = new EventEmitter();
    const streamMessage = mock((_options: StreamMessageOptions) => {
      aiEmitter.emit("stream-start", streamStartEvent(workspaceId));
      return Promise.resolve(Ok(createStartedTurnHandle("assistant-1")));
    });
    const { session, cleanup, historyService } = await createAgentSessionHarness({
      workspaceId,
      aiEmitter,
      aiServiceOverrides: { streamMessage: streamMessage as unknown as AIService["streamMessage"] },
      workspaceGoalService,
    });
    const originalCommitPartial = historyService.commitPartial.bind(historyService);
    let armed = false;
    const commitPartial = spyOn(historyService, "commitPartial").mockImplementation((...args) => {
      // The Pause lands after the resume's admission read, inside the stream's own pre-start I/O.
      if (armed) {
        stale = true;
      }
      return originalCommitPartial(...args);
    });

    try {
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("user-0", "user", "keep going", { timestamp: Date.now() })
      );
      const resumed = await session.resumeStream(
        { model: TEST_MODEL, agentId: "exec" },
        { agentInitiated: true, goalKind: GOAL_CONTINUATION_KIND, goalId: "goal-1" }
      );
      expect(resumed.success).toBe(true);
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("assistant-1", "assistant", "ran the checks", { timestamp: Date.now() })
      );

      const controller = new AbortController();
      session.queueMessage(
        "Background monitor wake",
        { model: TEST_MODEL, agentId: "exec" },
        {
          synthetic: true,
          agentInitiated: true,
          cancelState: { canceledBeforeAcceptance: false },
          cancelSignal: controller.signal,
          onCanceled: () => undefined,
        }
      );
      armed = true;
      streamMessage.mock.calls[0]?.[0].onQueuedMessageStop?.({ modelString: TEST_MODEL });
      controller.abort("monitor consumed");
      aiEmitter.emit("stream-end", streamEndEvent(workspaceId));

      expect(await waitForCondition(() => !session.isBusy())).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(streamMessage).toHaveBeenCalledTimes(1);
    } finally {
      commitPartial.mockRestore();
      session.dispose();
      await cleanup();
    }
  });

  test("disposing the session during the resume's pre-stream I/O cancels it", async () => {
    const workspaceId = "queue-dispatch-stranded-dispose-in-io";
    const harness = await strandWithResumeParkedInPreStreamIo(workspaceId);
    const { session, cleanup, streamMessage } = harness;

    try {
      // Workspace removal tears the session down while the resume is past streamWithHistory's
      // disposed check and StreamManager has no stream to stop.
      session.dispose();
      harness.releaseIo();

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(streamMessage).toHaveBeenCalledTimes(1);
    } finally {
      harness.restore();
      await cleanup();
    }
  });

  test("a system hard stop with no registered stream cancels a preparing resume", async () => {
    const workspaceId = "queue-dispatch-stranded-system-stop-in-io";
    const harness = await strandWithResumeParkedInPreStreamIo(workspaceId);
    const { session, cleanup, aiEmitter, streamMessage } = harness;

    try {
      // task_stop / interrupt cascade: clears the queue and hard-stops through aiService while
      // the resume is still preparing, so StreamManager emits a synthetic pre-stream abort.
      session.clearQueue("task stopped");
      aiEmitter.emit("stream-abort", streamAbortEvent(workspaceId, "system"));
      harness.releaseIo();

      expect(await waitForCondition(() => !session.isBusy())).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(streamMessage).toHaveBeenCalledTimes(1);
      session.drainQueuedMessagesIfIdle();
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(streamMessage).toHaveBeenCalledTimes(1);
    } finally {
      harness.restore();
      session.dispose();
      await cleanup();
    }
  });

  test("a thinking change still pending at the cut carries into the resume", async () => {
    const workspaceId = "queue-dispatch-stranded-pending-thinking";
    const harness = await createStreamingTurnHarness(workspaceId, {
      sendOptions: { thinkingLevel: "low" },
    });
    const { session, cleanup, aiEmitter, streamMessage } = harness;

    try {
      const original = harness.latestRequest();
      expect(original.thinkingLevel).toBe("low");
      // The user raised the level while a tool was running; the boundary was cut before any
      // prepareStep could apply it.
      expect(session.setActiveTurnThinkingLevel("high").accepted).toBe(true);
      expect(original.activeTurnThinkingOverride?.applied).toBeUndefined();

      const wake = harness.queueCancelableWake();
      original.onQueuedMessageStop?.({ modelString: TEST_MODEL });
      wake.abort("monitor consumed");
      aiEmitter.emit("stream-end", streamEndEvent(workspaceId));

      expect(await waitForCondition(() => streamMessage.mock.calls.length === 2)).toBe(true);
      expect(harness.latestRequest().thinkingLevel).toBe("high");
    } finally {
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
      aiEmitter.emit("stream-abort", streamAbortEvent(workspaceId, "queued-message"));

      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(sendQueuedMessages).not.toHaveBeenCalled();
    } finally {
      sendQueuedMessages.mockRestore();
      stopStream.mockRestore();
      session.dispose();
      await cleanup();
    }
  });

  test("rejected queued dispatch surfaces through onAcceptedPreStreamFailure", async () => {
    const workspaceId = "queue-dispatch-rejected";
    const { session, cleanup } = await createAgentSessionHarness({ workspaceId });
    const failures: string[] = [];

    try {
      session.queueMessage(
        "queued peer trigger",
        { model: TEST_MODEL, agentId: "exec" },
        {
          synthetic: true,
          // Peer sends refund their family-message reservation through this hook; a dispatch
          // that REJECTS (throws) instead of returning Err must reach it just like the
          // returned-error branch, or the reservation is stranded until restart.
          onAcceptedPreStreamFailure: (error) => {
            failures.push(error.type === "unknown" ? error.raw : error.type);
          },
        }
      );
      const sendMessage = spyOn(session, "sendMessage").mockImplementation(() =>
        Promise.reject(new Error("pricing gate exploded"))
      );
      session.sendQueuedMessages();
      expect(await waitForCondition(() => failures.length === 1)).toBe(true);
      expect(failures[0]).toContain("pricing gate exploded");
      sendMessage.mockRestore();
    } finally {
      session.dispose();
      await cleanup();
    }
  });
});
