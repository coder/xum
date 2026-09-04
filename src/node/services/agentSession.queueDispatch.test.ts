import { describe, expect, mock, spyOn, test } from "bun:test";

import type { MuxMessageMetadata } from "@/common/types/message";
import { Ok } from "@/common/types/result";
import type { WorkspaceGoalService } from "./workspaceGoalService";
import { createAgentSessionHarness, createStartedTurnHandle } from "./agentSession.testHarness";
import type { AIService } from "./aiService";
import type { AgentSession } from "./agentSession";

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

const DELEGATED_TURN: Extract<MuxMessageMetadata, { type: "workspace-turn-task" }> = {
  type: "workspace-turn-task",
  taskHandleId: "wst_delegated",
  ownerWorkspaceId: "owner-workspace",
  turnId: "turn-1",
};

/** The correlation the active stream runs under; a wake cut records it as the debt's owner. */
function setActiveStreamCorrelation(
  session: AgentSession,
  workspaceTurnMetadata: typeof DELEGATED_TURN | undefined
): void {
  (
    session as unknown as {
      activeStreamContext?: { workspaceTurnMetadata?: typeof DELEGATED_TURN };
    }
  ).activeStreamContext = { workspaceTurnMetadata };
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

  test("hasPendingToolEndInput unions the queued tool-end head with the live wake level", async () => {
    const workspaceId = "queue-dispatch-pending-tool-end-input";
    let level: () => Promise<boolean> = () => Promise.resolve(false);
    const { session, cleanup } = await createAgentSessionHarness({
      workspaceId,
      hasOutstandingBashMonitorWake: () => level(),
    });
    try {
      expect(await session.hasPendingToolEndInput()).toBe(false);

      // The level is read live — no snapshot survives from one boundary to the next.
      level = () => Promise.resolve(true);
      expect(await session.hasPendingToolEndInput()).toBe(true);
      level = () => Promise.resolve(false);
      expect(await session.hasPendingToolEndInput()).toBe(false);

      // A failing level read must not cut the stream on the level's account...
      level = () => Promise.reject(new Error("watermark read failed"));
      expect(await session.hasPendingToolEndInput()).toBe(false);
      // ...but a tool-end message queued while that read was in flight still arbitrates the
      // boundary: the failure says nothing about the queue.
      level = () => {
        session.queueMessage("correction", { model: TEST_MODEL, agentId: "exec" });
        return Promise.reject(new Error("watermark read failed"));
      };
      expect(await session.hasPendingToolEndInput()).toBe(true);
      session.clearQueue();

      // A non-empty queue arbitrates alone: a turn-end head is not promoted to tool-end by
      // a high wake level (the wake dispatcher waits for the queue to drain anyway).
      level = () => Promise.resolve(true);
      session.queueMessage("later", {
        model: TEST_MODEL,
        agentId: "exec",
        queueDispatchMode: "turn-end",
      });
      expect(await session.hasPendingToolEndInput()).toBe(false);
      session.clearQueue();
      expect(await session.hasPendingToolEndInput()).toBe(true);
      level = () => Promise.resolve(false);
      session.queueMessage("now", { model: TEST_MODEL, agentId: "exec" });
      expect(await session.hasPendingToolEndInput()).toBe(true);
    } finally {
      session.dispose();
      await cleanup();
    }
  });

  test("a stream cut for the wake level takes a continuation debt until other input supersedes it", async () => {
    // Settlement of a delegated turn runs after the cut and reads the debt (the cutter and
    // hasBashMonitorWakeContinuation), never the level: an operator canceling the monitor in
    // between must not be able to hide that the cut happened.
    const workspaceId = "queue-dispatch-wake-cut-debt";
    let level = false;
    let markStreamRequested: () => void = () => undefined;
    const streamRequested = new Promise<void>((resolve) => {
      markStreamRequested = resolve;
    });
    let releaseStream: () => void = () => undefined;
    const streamRelease = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    const voided: Array<[MuxMessageMetadata, string]> = [];
    const { session, cleanup } = await createAgentSessionHarness({
      workspaceId,
      hasOutstandingBashMonitorWake: () => Promise.resolve(level),
      onWorkspaceTurnContinuationVoided: (correlation, reason) => {
        voided.push([correlation, reason]);
        return Promise.resolve();
      },
      aiServiceOverrides: {
        streamMessage: mock(async () => {
          markStreamRequested();
          await streamRelease;
          return Ok(createStartedTurnHandle("test-assistant-message"));
        }),
      },
    });
    let disposed = false;
    try {
      // The cut stream's correlation is what the debt records.
      setActiveStreamCorrelation(session, DELEGATED_TURN);
      expect(session.getQueueCutCutter()).toBeUndefined();
      level = true;
      expect(await session.hasPendingToolEndInput()).toBe(true);
      level = false;
      expect(session.getQueueCutCutter()).toEqual({ stage: "bash-monitor-wake" });
      expect(session.hasBashMonitorWakeContinuation()).toBe(true);
      expect(session.hasPendingBashMonitorWakeTurn()).toBe(false);
      // Reading a low level later neither retracts the debt nor takes a second one.
      expect(await session.hasPendingToolEndInput()).toBe(false);
      expect(session.getQueueCutCutter()).toEqual({ stage: "bash-monitor-wake" });
      expect(voided).toEqual([]);

      // Input that is not the wake supersedes the continuation: the owner is told once, when
      // that input's row is durable, and the cutter is now the admitted input.
      const sendPromise = session.sendMessage("hello", { model: TEST_MODEL, agentId: "exec" });
      await streamRequested;
      expect(session.isBusy()).toBe(true);
      expect(voided).toEqual([[DELEGATED_TURN, "superseded"]]);
      expect(session.hasBashMonitorWakeContinuation()).toBe(false);
      expect(session.getQueueCutCutter()).toEqual({ stage: "preparing", muxMetadata: undefined });
      session.dispose();
      disposed = true;
      releaseStream();
      await sendPromise;
      expect(voided).toHaveLength(1);
    } finally {
      releaseStream();
      if (!disposed) session.dispose();
      await cleanup();
    }
  });

  test("a correlated turn admitted after the cut assumes the debt until its stream starts", async () => {
    // The delegated turn's own continuation (e.g. a queued same-turn message) supersedes
    // nothing: its stream-end settles the turn, so the owner is not told. Until that stream
    // starts the debt stays visible to settlement (a stream-end handler running in the gap
    // must still defer) and cannot be retracted by the level lowering.
    const workspaceId = "queue-dispatch-wake-cut-same-turn";
    let level = true;
    let markStreamRequested: () => void = () => undefined;
    const streamRequested = new Promise<void>((resolve) => {
      markStreamRequested = resolve;
    });
    let releaseStream: () => void = () => undefined;
    const streamRelease = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    const voided: unknown[] = [];
    const { session, cleanup, aiEmitter } = await createAgentSessionHarness({
      workspaceId,
      hasOutstandingBashMonitorWake: () => Promise.resolve(level),
      onWorkspaceTurnContinuationVoided: (...args) => {
        voided.push(args);
        return Promise.resolve();
      },
      aiServiceOverrides: {
        streamMessage: mock(async () => {
          markStreamRequested();
          await streamRelease;
          return Ok(createStartedTurnHandle("test-assistant-message"));
        }),
      },
    });
    let disposed = false;
    try {
      setActiveStreamCorrelation(session, DELEGATED_TURN);
      expect(await session.hasPendingToolEndInput()).toBe(true);
      level = false;
      const sendPromise = session.sendMessage("continue", {
        model: TEST_MODEL,
        agentId: "exec",
        muxMetadata: DELEGATED_TURN,
      });
      await streamRequested;
      expect(session.hasBashMonitorWakeContinuation()).toBe(true);
      // PREPARING attributes the cut to this continuation; either attribution defers.
      expect(session.getQueueCutCutter()?.stage).toBe("preparing");
      session.setBashMonitorWakeOutstanding(true);
      session.setBashMonitorWakeOutstanding(false);
      expect(session.hasBashMonitorWakeContinuation()).toBe(true);
      expect(voided).toEqual([]);

      aiEmitter.emit("stream-start", streamStartEvent(workspaceId));
      expect(session.hasBashMonitorWakeContinuation()).toBe(false);
      expect(session.getQueueCutCutter()).toBeUndefined();
      expect(voided).toEqual([]);
      session.dispose();
      disposed = true;
      releaseStream();
      await sendPromise;
    } finally {
      releaseStream();
      if (!disposed) session.dispose();
      await cleanup();
    }
  });

  test("the stream-start ledger remembers a correlated continuation after it ended", async () => {
    // A stream-end handler can run after the turn's next stream already started and ended;
    // it asks the ledger whether the turn continued after the stream it handles.
    const workspaceId = "queue-dispatch-stream-ledger";
    const { session, cleanup, aiEmitter } = await createAgentSessionHarness({ workspaceId });
    try {
      const startedAs = (messageId: string, correlation: typeof DELEGATED_TURN | undefined) => {
        setActiveStreamCorrelation(session, correlation);
        aiEmitter.emit("stream-start", { ...streamStartEvent(workspaceId), messageId });
      };
      startedAs("assistant-delegated-1", DELEGATED_TURN);
      expect(
        session.hasCorrelatedStreamStartedAfter(DELEGATED_TURN, ["assistant-delegated-1"])
      ).toBe(false);

      startedAs("assistant-manual", undefined);
      expect(
        session.hasCorrelatedStreamStartedAfter(DELEGATED_TURN, ["assistant-delegated-1"])
      ).toBe(false);

      startedAs("assistant-delegated-2", DELEGATED_TURN);
      expect(
        session.hasCorrelatedStreamStartedAfter(DELEGATED_TURN, ["assistant-delegated-1"])
      ).toBe(true);
      // Relative to the continuation itself nothing followed.
      expect(
        session.hasCorrelatedStreamStartedAfter(DELEGATED_TURN, ["assistant-delegated-2"])
      ).toBe(false);
      // A different turn's correlation never matches.
      expect(
        session.hasCorrelatedStreamStartedAfter({ ...DELEGATED_TURN, turnId: "turn-2" }, [
          "assistant-delegated-1",
        ])
      ).toBe(false);
      // A stream the ledger no longer holds predates everything remembered.
      expect(session.hasCorrelatedStreamStartedAfter(DELEGATED_TURN, ["assistant-evicted"])).toBe(
        true
      );
    } finally {
      session.dispose();
      await cleanup();
    }
  });

  test("the level lowering with no wake turn in flight voids the debt as retracted", async () => {
    const workspaceId = "queue-dispatch-wake-retracted";
    const voided: Array<[MuxMessageMetadata, string]> = [];
    const { session, cleanup } = await createAgentSessionHarness({
      workspaceId,
      hasOutstandingBashMonitorWake: () => Promise.resolve(true),
      onWorkspaceTurnContinuationVoided: (correlation, reason) => {
        voided.push([correlation, reason]);
        return Promise.resolve();
      },
    });
    try {
      setActiveStreamCorrelation(session, DELEGATED_TURN);
      session.setBashMonitorWakeOutstanding(true);
      expect(await session.hasPendingToolEndInput()).toBe(true);
      expect(session.getQueueCutCutter()).toEqual({ stage: "bash-monitor-wake" });

      // Republishing high changes nothing; lowering it (monitor canceled, output shown,
      // history cleared) leaves no wake to continue the cut stream.
      session.setBashMonitorWakeOutstanding(true);
      expect(voided).toEqual([]);
      session.setBashMonitorWakeOutstanding(false);
      expect(voided).toEqual([[DELEGATED_TURN, "retracted"]]);
      expect(session.getQueueCutCutter()).toBeUndefined();
      expect(session.hasBashMonitorWakeContinuation()).toBe(false);

      // A cut with no correlation (manual stream) still records the cutter but has no
      // owner to tell.
      setActiveStreamCorrelation(session, undefined);
      session.setBashMonitorWakeOutstanding(true);
      expect(await session.hasPendingToolEndInput()).toBe(true);
      session.setBashMonitorWakeOutstanding(false);
      expect(session.getQueueCutCutter()).toBeUndefined();
      expect(voided).toHaveLength(1);
    } finally {
      session.dispose();
      await cleanup();
    }
  });

  test("a wake send is in flight from its first synchronous step until its stream starts", async () => {
    // The wake's onAccepted lowers the level as soon as its row is durable, which is before
    // PREPARING and long before a stream exists. Only the in-flight marker keeps the debt
    // from being voided in that window.
    const workspaceId = "queue-dispatch-wake-in-flight";
    let markStreamRequested: () => void = () => undefined;
    const streamRequested = new Promise<void>((resolve) => {
      markStreamRequested = resolve;
    });
    let releaseStream: () => void = () => undefined;
    const streamRelease = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    const voided: unknown[] = [];
    const { session, aiEmitter, cleanup } = await createAgentSessionHarness({
      workspaceId,
      hasOutstandingBashMonitorWake: () => Promise.resolve(true),
      onWorkspaceTurnContinuationVoided: (...args) => {
        voided.push(args);
        return Promise.resolve();
      },
      aiServiceOverrides: {
        streamMessage: mock(async () => {
          markStreamRequested();
          await streamRelease;
          return Ok(createStartedTurnHandle("test-assistant-message"));
        }),
      },
    });

    let disposed = false;
    try {
      setActiveStreamCorrelation(session, DELEGATED_TURN);
      session.setBashMonitorWakeOutstanding(true);
      expect(await session.hasPendingToolEndInput()).toBe(true);
      setActiveStreamCorrelation(session, undefined);

      expect(session.hasPendingBashMonitorWakeTurn()).toBe(false);
      let accepted = false;
      const sendPromise = session.sendMessage(
        "Background monitor wake",
        {
          model: TEST_MODEL,
          agentId: "exec",
          muxMetadata: { type: "bash-monitor-wake", records: [] },
        },
        {
          synthetic: true,
          agentInitiated: true,
          onAccepted: () => {
            accepted = true;
            // The reconciler consumes the signals and publishes low here.
            session.setBashMonitorWakeOutstanding(false);
          },
        }
      );
      // Synchronously at entry, before any admission await.
      expect(session.hasPendingBashMonitorWakeTurn()).toBe(true);

      await streamRequested;
      expect(accepted).toBe(true);
      expect(session.isBusy()).toBe(true);
      expect(session.hasPendingBashMonitorWakeTurn()).toBe(true);
      expect(session.hasBashMonitorWakeContinuation()).toBe(true);
      expect(voided).toEqual([]);

      // The wake stream shows the wake: debt redeemed, nothing to tell the owner.
      aiEmitter.emit("stream-start", streamStartEvent(workspaceId));
      expect(session.hasPendingBashMonitorWakeTurn()).toBe(false);
      expect(session.hasBashMonitorWakeContinuation()).toBe(false);
      expect(session.getQueueCutCutter()).toBeUndefined();
      expect(voided).toEqual([]);

      session.dispose();
      disposed = true;
      releaseStream();
      await sendPromise;
      expect(voided).toEqual([]);
    } finally {
      releaseStream();
      if (!disposed) session.dispose();
      await cleanup();
    }
  });

  test("a wake send refused before its row is durable leaves the debt to the next dispatch", async () => {
    // Pre-commit refusals (stale admission) do not lower the level, so the debt is still
    // owed and the reconciler re-dispatches; only a level drop voids it.
    const workspaceId = "queue-dispatch-wake-refused";
    const voided: Array<[MuxMessageMetadata, string]> = [];
    const { session, cleanup } = await createAgentSessionHarness({
      workspaceId,
      hasOutstandingBashMonitorWake: () => Promise.resolve(true),
      onWorkspaceTurnContinuationVoided: (correlation, reason) => {
        voided.push([correlation, reason]);
        return Promise.resolve();
      },
    });
    try {
      setActiveStreamCorrelation(session, DELEGATED_TURN);
      session.setBashMonitorWakeOutstanding(true);
      expect(await session.hasPendingToolEndInput()).toBe(true);

      let accepted = false;
      const result = await session.sendMessage(
        "Background monitor wake",
        {
          model: TEST_MODEL,
          agentId: "exec",
          muxMetadata: { type: "bash-monitor-wake", records: [] },
        },
        {
          synthetic: true,
          agentInitiated: true,
          admissionStale: () => true,
          onAccepted: () => {
            accepted = true;
          },
        }
      );
      expect(result.success).toBe(false);
      expect(accepted).toBe(false);
      expect(session.hasPendingBashMonitorWakeTurn()).toBe(false);
      expect(session.getQueueCutCutter()).toEqual({ stage: "bash-monitor-wake" });
      expect(voided).toEqual([]);

      session.setBashMonitorWakeOutstanding(false);
      expect(voided).toEqual([[DELEGATED_TURN, "retracted"]]);
    } finally {
      session.dispose();
      await cleanup();
    }
  });

  test("other input supersedes the debt only once its own row is durable", async () => {
    // A superseding send that is refused before anything is persisted changes nothing: the
    // wake is still outstanding and will still continue the delegated turn. Admission
    // (PREPARING) is a reservation, not acceptance.
    const workspaceId = "queue-dispatch-supersede-at-acceptance";
    const voided: Array<[MuxMessageMetadata, string]> = [];
    const { session, cleanup } = await createAgentSessionHarness({
      workspaceId,
      hasOutstandingBashMonitorWake: () => Promise.resolve(true),
      onWorkspaceTurnContinuationVoided: (correlation, reason) => {
        voided.push([correlation, reason]);
        return Promise.resolve();
      },
    });
    try {
      setActiveStreamCorrelation(session, DELEGATED_TURN);
      session.setBashMonitorWakeOutstanding(true);
      expect(await session.hasPendingToolEndInput()).toBe(true);

      const refused = await session.sendMessage(
        "peer message",
        { model: TEST_MODEL, agentId: "exec" },
        { admissionStale: () => true }
      );
      expect(refused.success).toBe(false);
      expect(session.getQueueCutCutter()).toEqual({ stage: "bash-monitor-wake" });
      expect(session.hasBashMonitorWakeContinuation()).toBe(true);
      expect(voided).toEqual([]);

      // The same input accepted (row durable) supersedes it exactly once.
      const accepted = await session.sendMessage("peer message", {
        model: TEST_MODEL,
        agentId: "exec",
      });
      expect(accepted.success).toBe(true);
      expect(voided).toEqual([[DELEGATED_TURN, "superseded"]]);
      expect(session.hasBashMonitorWakeContinuation()).toBe(false);
    } finally {
      session.dispose();
      await cleanup();
    }
  });

  test("a void whose owner-side settlement fails is retried at the next debt transition", async () => {
    // The debt is cleared when it is voided; the settlement itself is I/O on the owner's side
    // and may fail transiently. The void is kept and retried rather than logged away, so a
    // delegated handle already deferred on the debt does not wait for a restart.
    const workspaceId = "queue-dispatch-void-retry";
    const calls: Array<[MuxMessageMetadata, string]> = [];
    let failNext = true;
    const { session, cleanup } = await createAgentSessionHarness({
      workspaceId,
      hasOutstandingBashMonitorWake: () => Promise.resolve(true),
      onWorkspaceTurnContinuationVoided: (correlation, reason) => {
        calls.push([correlation, reason]);
        if (failNext) {
          failNext = false;
          return Promise.reject(new Error("handle store unavailable"));
        }
        return Promise.resolve();
      },
    });
    try {
      setActiveStreamCorrelation(session, DELEGATED_TURN);
      session.setBashMonitorWakeOutstanding(true);
      expect(await session.hasPendingToolEndInput()).toBe(true);

      session.setBashMonitorWakeOutstanding(false);
      expect(calls).toEqual([[DELEGATED_TURN, "retracted"]]);
      // Let the rejection settle; the debt itself stays cleared (the cut is not re-attributed).
      await Promise.resolve();
      await Promise.resolve();
      expect(session.hasBashMonitorWakeContinuation()).toBe(false);

      // Any later level transition retries the parked void with the original reason.
      session.setBashMonitorWakeOutstanding(true);
      session.setBashMonitorWakeOutstanding(false);
      expect(calls).toEqual([
        [DELEGATED_TURN, "retracted"],
        [DELEGATED_TURN, "retracted"],
      ]);
      await Promise.resolve();
      session.setBashMonitorWakeOutstanding(true);
      session.setBashMonitorWakeOutstanding(false);
      expect(calls).toHaveLength(2);
    } finally {
      session.dispose();
      await cleanup();
    }
  });

  test("a queued head is not recorded as a wake cut", async () => {
    const workspaceId = "queue-dispatch-queue-cut-not-wake";
    let releaseLevel: () => void = () => undefined;
    const { session, cleanup } = await createAgentSessionHarness({
      workspaceId,
      hasOutstandingBashMonitorWake: () =>
        new Promise<boolean>((resolve) => {
          releaseLevel = () => resolve(true);
        }),
    });
    try {
      // A message queued while the level is being read arbitrates like one queued before:
      // a turn-end head means no cut (and no wake attribution), a tool-end head cuts as
      // queued input.
      const pendingTurnEnd = session.hasPendingToolEndInput();
      session.queueMessage("later", {
        model: TEST_MODEL,
        agentId: "exec",
        queueDispatchMode: "turn-end",
      });
      releaseLevel();
      expect(await pendingTurnEnd).toBe(false);
      expect(session.getQueueCutCutter()).toMatchObject({ stage: "queued" });
      session.clearQueue();

      const pendingToolEnd = session.hasPendingToolEndInput();
      session.queueMessage("now", { model: TEST_MODEL, agentId: "exec" });
      releaseLevel();
      expect(await pendingToolEnd).toBe(true);
      expect(session.getQueueCutCutter()).toMatchObject({ stage: "queued" });
      session.clearQueue();
      expect(session.getQueueCutCutter()).toBeUndefined();
    } finally {
      session.dispose();
      await cleanup();
    }
  });

  test("the wake level and the queue head jointly drive the bash early-return flag", async () => {
    const workspaceId = "queue-dispatch-yield-flag";
    const flags: boolean[] = [];
    const { session, cleanup } = await createAgentSessionHarness({
      workspaceId,
      backgroundProcessManagerOverrides: {
        setMessageQueued: (_workspaceId: string, queued: boolean) => {
          flags.push(queued);
        },
      },
    });
    const lastFlag = () => flags.at(-1);
    try {
      session.setBashMonitorWakeOutstanding(true);
      expect(lastFlag()).toBe(true);
      session.setBashMonitorWakeOutstanding(false);
      expect(lastFlag()).toBe(false);

      // Clearing the queue while the level is high must not drop the flag.
      session.queueMessage("follow up", { model: TEST_MODEL, agentId: "exec" });
      expect(lastFlag()).toBe(true);
      session.setBashMonitorWakeOutstanding(true);
      session.clearQueue();
      expect(lastFlag()).toBe(true);
      session.setBashMonitorWakeOutstanding(false);
      expect(lastFlag()).toBe(false);

      // A turn-end head owns the next dispatch: the level must not pull the early-return
      // lever for it (mirrors hasPendingToolEndInput's arbitration).
      session.setBashMonitorWakeOutstanding(true);
      session.queueMessage("later", {
        model: TEST_MODEL,
        agentId: "exec",
        queueDispatchMode: "turn-end",
      });
      expect(lastFlag()).toBe(false);
      session.clearQueue();
      expect(lastFlag()).toBe(true);
      session.setBashMonitorWakeOutstanding(false);
    } finally {
      session.dispose();
      await cleanup();
    }
  });

  test("the tool-end yield edge fires once per rising transition, whatever raises it", async () => {
    // Foreground task waits are backgrounded on this edge, so it must track the *effective*
    // lever (queue-head arbitration ∪ level), not the events that happen to feed it
    // (Codex P2 PRRT_kwDOPxxmWM6fGVw_).
    const workspaceId = "queue-dispatch-yield-edge";
    const edges = mock(() => undefined);
    const { session, cleanup } = await createAgentSessionHarness({
      workspaceId,
      onToolEndYieldRequested: edges,
    });
    const turnEnd = { model: TEST_MODEL, agentId: "exec", queueDispatchMode: "turn-end" as const };
    const toolEnd = { model: TEST_MODEL, agentId: "exec", queueDispatchMode: "tool-end" as const };
    try {
      // A turn-end head does not pull the lever; a tool-end enqueue does, once.
      session.queueMessage("later", turnEnd);
      expect(edges).not.toHaveBeenCalled();
      session.queueMessage("sooner", toolEnd);
      expect(edges).toHaveBeenCalledTimes(1);
      session.queueMessage("sooner still", toolEnd);
      expect(edges).toHaveBeenCalledTimes(1);
      session.clearQueue();

      // The GVw_ case: the level is high behind a turn-end head (no edge), then the head is
      // cleared with no enqueue and no level publish in between — the lever becomes
      // effective and the edge must fire from that queue transition alone.
      session.queueMessage("later", turnEnd);
      session.setBashMonitorWakeOutstanding(true);
      expect(edges).toHaveBeenCalledTimes(1);
      session.clearQueue();
      expect(edges).toHaveBeenCalledTimes(2);

      // Republishing a high level is not an edge; lowering and raising it is.
      session.setBashMonitorWakeOutstanding(true);
      expect(edges).toHaveBeenCalledTimes(2);
      session.setBashMonitorWakeOutstanding(false);
      session.setBashMonitorWakeOutstanding(true);
      expect(edges).toHaveBeenCalledTimes(3);
      session.setBashMonitorWakeOutstanding(false);

      // tool-end is sticky within an entry: a turn-end queued behind it neither lowers the
      // lever nor re-fires the edge.
      session.queueMessage("sooner", toolEnd);
      expect(edges).toHaveBeenCalledTimes(4);
      session.queueMessage("later", turnEnd);
      expect(edges).toHaveBeenCalledTimes(4);
      expect(session.hasQueuedMessages()).toBe(true);
    } finally {
      session.dispose();
      await cleanup();
    }
  });

  test("disposing a session lowers the mirrored wake level", async () => {
    // The flag lives in BackgroundProcessManager keyed by workspace id and outlives the
    // session; a stale true would make a re-created session's bash reads return early.
    const workspaceId = "queue-dispatch-dispose-clears-level";
    const flags: boolean[] = [];
    const { session, cleanup } = await createAgentSessionHarness({
      workspaceId,
      backgroundProcessManagerOverrides: {
        setMessageQueued: (_workspaceId: string, queued: boolean) => {
          flags.push(queued);
        },
      },
    });
    try {
      session.setBashMonitorWakeOutstanding(true);
      expect(flags.at(-1)).toBe(true);
      session.dispose();
      expect(flags.at(-1)).toBe(false);
    } finally {
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
      let accepted = false;
      const sendPromise = session.sendMessage(
        "Background monitor wake",
        {
          model: TEST_MODEL,
          agentId: "exec",
          muxMetadata: { type: "bash-monitor-wake", records: [] },
        },
        {
          synthetic: true,
          agentInitiated: true,
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
      const canceledReasons: string[] = [];
      let accepted = false;
      // Acceptance consumes the reconciler signal, so an in-session resume must already be
      // armed by then: nothing upstream can resend the durable row (Codex P2
      // PRRT_kwDOPxxmWM6fOH54).
      let resumeArmedAtAcceptance = false;
      const chatEventTypes: string[] = [];
      const unsubscribe = session.onChatEvent((event) => {
        chatEventTypes.push(event.message.type);
      });
      const readResumeRequest = () =>
        (
          session as unknown as {
            lastAutoRetryResumeRequest?: { options: { muxMetadata?: unknown } };
          }
        ).lastAutoRetryResumeRequest;
      const sendPromise = session.sendMessage(
        "Background monitor wake",
        {
          model: TEST_MODEL,
          agentId: "exec",
          muxMetadata: { type: "bash-monitor-wake", records: [] },
        },
        {
          synthetic: true,
          agentInitiated: true,
          onCanceled: (reason) => {
            canceledReasons.push(reason);
          },
          onAccepted: () => {
            accepted = true;
            resumeArmedAtAcceptance = readResumeRequest() != null;
          },
        }
      );

      await syncStarted;
      expect(readResumeRequest()).toBeUndefined();
      releaseSync();
      let syncError: unknown;
      try {
        await sendPromise;
      } catch (error) {
        syncError = error;
      }
      unsubscribe();
      expect(syncError).toBeInstanceOf(Error);
      expect((syncError as Error).message).toContain("injected goal sync failure");

      expect(accepted).toBe(true);
      expect(canceledReasons).toEqual([]);
      expect(resumeArmedAtAcceptance).toBe(true);
      expect(readResumeRequest()?.options.muxMetadata).toEqual({
        type: "bash-monitor-wake",
        records: [],
      });
      expect(chatEventTypes).toContain("auto-retry-scheduled");
      // The armed resume is what will bring the wake's stream, so the wake turn stays in
      // flight (a debt it carries is not voided) until that retry is given up.
      expect(session.hasPendingBashMonitorWakeTurn()).toBe(true);
      await session.setAutoRetryEnabled(false, { persist: false });
      expect(session.hasPendingBashMonitorWakeTurn()).toBe(false);
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
