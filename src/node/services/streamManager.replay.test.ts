import { describe, test, expect } from "bun:test";
import {
  StreamManager,
  type StreamManagerTokenTracker,
  type TurnEngineEvent,
} from "./streamManager";
import {
  createStreamManagerForTests,
  engineInternals,
  onTurnEngineEvent,
} from "./streamManager.testHarness";
import { installStreamManagerTestHistory, historyService } from "./streamManager.suite.testHarness";

installStreamManagerTestHistory();

describe("StreamManager - replayStream", () => {
  function createReplayTokenTracker(): StreamManagerTokenTracker {
    return { setModel: () => Promise.resolve(), countTokens: () => Promise.resolve(1) };
  }

  function createReplayStreamManager(
    tokenTracker: StreamManagerTokenTracker = createReplayTokenTracker()
  ): StreamManager {
    return createStreamManagerForTests(historyService, { tokenTracker });
  }

  function setReplayStreamInfo(
    streamManager: StreamManager,
    workspaceId: string,
    streamInfo: Record<string, unknown>
  ): void {
    engineInternals(streamManager).workspaceStreams.set(workspaceId, streamInfo);
  }

  test("replayStream snapshots parts so reconnect doesn't block until stream ends", async () => {
    const tokenTracker = createReplayTokenTracker();
    const streamManager = createReplayStreamManager(tokenTracker);

    let sawStreamStart = false;
    onTurnEngineEvent(streamManager, "stream-start", (event: { replay?: boolean | undefined }) => {
      sawStreamStart = true;
      expect(event.replay).toBe(true);
    });
    const workspaceId = "ws-replay-snapshot";

    const deltas: string[] = [];
    onTurnEngineEvent(
      streamManager,
      "stream-delta",
      (event: { delta: string; replay?: boolean | undefined }) => {
        expect(event.replay).toBe(true);
        deltas.push(event.delta);
      }
    );

    const streamInfo = {
      state: "streaming",
      messageId: "msg-1",
      model: "claude-sonnet-4",
      historySequence: 1,
      startTime: 123,
      initialMetadata: {},
      parts: [{ type: "text", text: "a", timestamp: 10 }],
    };

    setReplayStreamInfo(streamManager, workspaceId, streamInfo);

    let pushed = false;
    tokenTracker.countTokens = async () => {
      if (!pushed) {
        pushed = true;
        // While replay is mid-await, simulate the running stream appending more parts.
        (streamInfo.parts as Array<{ type: string; text?: string; timestamp?: number }>).push({
          type: "text",
          text: "b",
          timestamp: 20,
        });
      }
      // Force an await boundary so the mutation happens during replay.
      await new Promise((resolve) => setTimeout(resolve, 0));
      return 1;
    };

    await streamManager.replayStream(workspaceId);
    expect(sawStreamStart).toBe(true);

    // If replayStream iterates the live array, it would also emit "b".
    expect(deltas).toEqual(["a"]);
  });

  test("replayStream filters output-available tool parts using completion timestamps", async () => {
    const streamManager = createReplayStreamManager();

    const workspaceId = "ws-replay-tool-filter";

    const replayedToolEnds: string[] = [];
    onTurnEngineEvent(
      streamManager,
      "tool-call-end",
      (event: { replay?: boolean | undefined; toolCallId: string }) => {
        expect(event.replay).toBe(true);
        replayedToolEnds.push(event.toolCallId);
      }
    );

    const streamInfo = {
      state: "streaming",
      messageId: "msg-tools",
      model: "claude-sonnet-4",
      historySequence: 1,
      startTime: 123,
      initialMetadata: {},
      toolCompletionTimestamps: new Map([
        ["tool-old", 15],
        ["tool-new", 30],
      ]),
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "tool-old",
          toolName: "bash",
          input: {},
          state: "output-available",
          output: { ok: true },
          timestamp: 10,
        },
        {
          type: "dynamic-tool",
          toolCallId: "tool-new",
          toolName: "bash",
          input: {},
          state: "output-available",
          output: { ok: true },
          timestamp: 12,
        },
      ],
    };

    setReplayStreamInfo(streamManager, workspaceId, streamInfo);

    await streamManager.replayStream(workspaceId, { afterTimestamp: 20 });

    expect(replayedToolEnds).toEqual(["tool-new"]);
  });

  test("replayStream replays queued tool parts whose execute() began after the cursor", async () => {
    const streamManager = createReplayStreamManager();

    const workspaceId = "ws-replay-exec-start";

    const replayedToolStarts: Array<{ toolCallId: string; executionStartedAt?: number }> = [];
    onTurnEngineEvent(
      streamManager,
      "tool-call-start",
      (event: {
        replay?: boolean | undefined;
        toolCallId: string;
        executionStartedAt?: number;
      }) => {
        expect(event.replay).toBe(true);
        replayedToolStarts.push({
          toolCallId: event.toolCallId,
          executionStartedAt: event.executionStartedAt,
        });
      }
    );

    const streamInfo = {
      state: "streaming",
      messageId: "msg-exec-start",
      model: "claude-sonnet-4",
      historySequence: 1,
      startTime: 123,
      initialMetadata: {},
      toolCompletionTimestamps: new Map(),
      parts: [
        {
          // Queued before the cursor, still waiting for the execution lock: not replayed.
          type: "dynamic-tool",
          toolCallId: "tool-still-queued",
          toolName: "bash",
          input: {},
          state: "input-available",
          timestamp: 10,
        },
        {
          // Queued before the cursor, execute() began after it: replayed with the
          // enriched executionStartedAt so the renderer can start the elapsed timer.
          type: "dynamic-tool",
          toolCallId: "tool-started-after-cursor",
          toolName: "bash",
          input: {},
          state: "input-available",
          timestamp: 12,
          executionStartedAt: 25,
        },
      ],
    };

    setReplayStreamInfo(streamManager, workspaceId, streamInfo);

    await streamManager.replayStream(workspaceId, { afterTimestamp: 20 });

    expect(replayedToolStarts).toEqual([
      { toolCallId: "tool-started-after-cursor", executionStartedAt: 25 },
    ]);
  });

  test("replayStream emits replay usage-delta from tracked step/cumulative usage", async () => {
    const streamManager = createReplayStreamManager();

    const workspaceId = "ws-replay-usage";
    const usageEvents: Array<Extract<TurnEngineEvent, { type: "usage-delta" }>> = [];

    onTurnEngineEvent(streamManager, "usage-delta", (event) => {
      usageEvents.push(event);
    });

    setReplayStreamInfo(streamManager, workspaceId, {
      state: "streaming",
      messageId: "msg-usage",
      model: "claude-sonnet-4",
      metadataModel: "claude-sonnet-4",
      historySequence: 1,
      startTime: 123,
      initialMetadata: { costsIncluded: true },
      toolCompletionTimestamps: new Map<string, number>(),
      parts: [{ type: "text", text: "hello", timestamp: 10 }],
      lastStepUsage: { inputTokens: 21, outputTokens: 3, totalTokens: 24 },
      cumulativeUsage: { inputTokens: 55, outputTokens: 11, totalTokens: 66 },
      lastStepProviderMetadata: { anthropic: { cacheReadInputTokens: 2 } },
      cumulativeProviderMetadata: { anthropic: { cacheCreationInputTokens: 9 } },
    });

    await streamManager.replayStream(workspaceId);

    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]?.replay).toBe(true);
    expect(usageEvents[0]?.usage).toEqual({ inputTokens: 21, outputTokens: 3, totalTokens: 24 });
    expect(usageEvents[0]?.providerMetadata).toEqual({
      anthropic: { cacheReadInputTokens: 2 },
    });
    expect(usageEvents[0]?.cumulativeUsage).toEqual({
      inputTokens: 55,
      outputTokens: 11,
      totalTokens: 66,
    });
    expect(usageEvents[0]?.cumulativeProviderMetadata).toEqual({
      anthropic: { cacheCreationInputTokens: 9 },
      mux: { costsIncluded: true },
    });
  });
  test("replayStream skips replay usage-delta for incremental afterTimestamp replays", async () => {
    const streamManager = createReplayStreamManager();

    const workspaceId = "ws-replay-usage-incremental";
    const usageEvents: Array<{ replay?: boolean }> = [];

    onTurnEngineEvent(streamManager, "usage-delta", (event: { replay?: boolean }) => {
      usageEvents.push(event);
    });

    setReplayStreamInfo(streamManager, workspaceId, {
      state: "streaming",
      messageId: "msg-usage-incremental",
      model: "claude-sonnet-4",
      metadataModel: "claude-sonnet-4",
      historySequence: 1,
      startTime: 123,
      initialMetadata: {},
      toolCompletionTimestamps: new Map<string, number>(),
      parts: [{ type: "text", text: "hello", timestamp: 10 }],
      lastStepUsage: { inputTokens: 21, outputTokens: 3, totalTokens: 24 },
      cumulativeUsage: { inputTokens: 55, outputTokens: 11, totalTokens: 66 },
      lastStepProviderMetadata: { anthropic: { cacheReadInputTokens: 2 } },
      cumulativeProviderMetadata: { anthropic: { cacheCreationInputTokens: 9 } },
    });

    await streamManager.replayStream(workspaceId, { afterTimestamp: 999 });

    expect(usageEvents).toHaveLength(0);
  });
});

describe("StreamManager - getStreamInfo", () => {
  test("returns startTime so reconnect cursors can preserve live-only boundaries", () => {
    const streamManager = new StreamManager(historyService);
    const workspaceId = "ws-get-stream-info";

    engineInternals(streamManager).workspaceStreams.set(workspaceId, {
      state: "starting",
      messageId: "msg-starting",
      model: "claude-sonnet-4",
      historySequence: 1,
      startTime: 4_321,
      initialMetadata: { systemMessageTokens: 2_048 },
      currentStepStartIndex: 0,
      stepStartIndices: [0],
      parts: [],
      toolCompletionTimestamps: new Map<string, number>(),
    });

    const streamInfo = streamManager.getStreamInfo(workspaceId);

    expect(streamInfo?.messageId).toBe("msg-starting");
    expect(streamInfo?.startTime).toBe(4_321);
    expect(streamInfo?.initialMetadata?.systemMessageTokens).toBe(2_048);
    expect(streamInfo?.currentStepStartIndex).toBe(0);
    expect(streamInfo?.stepStartIndices).toEqual([0]);
    streamInfo?.stepStartIndices.push(5);
    expect(streamManager.getStreamInfo(workspaceId)?.stepStartIndices).toEqual([0]);
  });
});
