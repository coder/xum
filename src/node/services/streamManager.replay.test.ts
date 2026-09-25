import { describe, test, expect } from "bun:test";
import { tool, type Tool, type ToolExecutionOptions } from "ai";
import { z } from "zod";
import type {
  StreamManagerTokenTracker,
  TurnEngineEvent,
  TurnExecutionOptions,
} from "./streamManager";
import {
  createStreamManagerForTests,
  fakeStreamText,
  type StreamManagerTestDeps,
} from "./streamManager.testHarness";
import {
  installStreamManagerTestHistory,
  historyService,
  createTestLanguageModel,
  testStartOptions,
  appendPartialAssistantForTests,
  createStreamResultForTests,
} from "./streamManager.suite.testHarness";

installStreamManagerTestHistory();

const END_OF_STREAM = Symbol("end-of-stream");

/**
 * A provider fullStream the test feeds one chunk at a time. push() resolves only
 * after StreamManager finished processing each chunk and asked for the next one,
 * so tests observe (and replay) a live stream at an exact point.
 */
function createChunkFeed() {
  let deliver: ((chunk: unknown) => void) | undefined;
  let signalWaiting!: () => void;
  let waiting = new Promise<void>((resolve) => (signalWaiting = resolve));
  async function* fullStream() {
    while (true) {
      const chunk = await new Promise<unknown>((resolve) => {
        deliver = resolve;
        signalWaiting();
      });
      if (chunk === END_OF_STREAM) return;
      yield chunk;
    }
  }
  const send = async (chunk: unknown) => {
    await waiting;
    waiting = new Promise<void>((resolve) => (signalWaiting = resolve));
    const next = deliver;
    deliver = undefined;
    if (next == null) throw new Error("chunk feed has no waiting consumer");
    next(chunk);
  };
  return {
    fullStream: fullStream(),
    waiting: () => waiting,
    push: async (...chunks: unknown[]) => {
      for (const chunk of chunks) {
        await send(chunk);
        await waiting;
      }
    },
    end: () => send(END_OF_STREAM),
  };
}

interface LiveStream {
  push: (...chunks: unknown[]) => Promise<void>;
  /** Ends the stream normally and waits for its completion. */
  finish: () => Promise<void>;
}

type LiveStreamOptions = Partial<TurnExecutionOptions> &
  Pick<TurnExecutionOptions, "workspaceId" | "messageId">;

/**
 * A real StreamManager whose provider streams come from chunk feeds. Every
 * engine event lands in `events`; `tools()` returns the tool set StreamManager
 * handed to the provider (wrapped by withSequentialExecution), so a test can
 * run execute() the way the AI SDK would.
 */
function createLiveStreamHarness(deps: StreamManagerTestDeps = {}) {
  const events: TurnEngineEvent[] = [];
  let feed: ReturnType<typeof createChunkFeed> | undefined;
  let providerTools: Record<string, Tool> = {};
  const streamManager = createStreamManagerForTests(historyService, {
    ...deps,
    eventSink: (event) => {
      events.push(event);
    },
    streamText: fakeStreamText((options) => {
      providerTools = (options.tools ?? {}) as Record<string, Tool>;
      // Each started stream consumes its feed once; a retry would see an empty stream.
      const fullStream =
        feed?.fullStream ??
        (async function* () {
          // No feed left: an unexpected second request streams nothing.
        })();
      feed = undefined;
      return createStreamResultForTests(fullStream);
    }),
  });
  return {
    streamManager,
    events,
    tools: () => providerTools,
    /** Starts a stream and waits until StreamManager awaits its first chunk. */
    async start(options: LiveStreamOptions): Promise<LiveStream> {
      const streamFeed = createChunkFeed();
      feed = streamFeed;
      await appendPartialAssistantForTests(options.workspaceId, options.messageId, 1);
      const result = await streamManager.startStream(
        testStartOptions({
          model: createTestLanguageModel(),
          providedRuntimeTempDir: "",
          ...options,
        })
      );
      if (!result.success) throw new Error("Expected stream to start");
      await streamFeed.waiting();
      return {
        push: streamFeed.push,
        finish: async () => {
          await streamFeed.push({ type: "finish", finishReason: "stop" });
          await streamFeed.end();
          await result.data.completion;
        },
      };
    },
  };
}

function eventsOfType<T extends TurnEngineEvent["type"]>(
  events: readonly TurnEngineEvent[],
  type: T
): Array<Extract<TurnEngineEvent, { type: T }>> {
  return events.filter((event): event is Extract<TurnEngineEvent, { type: T }> => {
    return event.type === type;
  });
}

function isReplay(event: TurnEngineEvent): boolean {
  return (event as { replay?: boolean }).replay === true;
}

function toolCall(toolCallId: string) {
  return { type: "tool-call", toolCallId, toolName: "bash", input: { script: "true" } };
}

function toolResult(toolCallId: string) {
  return { type: "tool-result", toolCallId, toolName: "bash", output: { ok: true } };
}

describe("StreamManager - replayStream", () => {
  test("replayStream snapshots parts so reconnect doesn't block until stream ends", async () => {
    const liveRef: { current?: LiveStream } = {};
    let appendDuringReplay = false;
    const tokenTracker: StreamManagerTokenTracker = {
      setModel: () => Promise.resolve(),
      countTokens: async () => {
        if (appendDuringReplay && liveRef.current) {
          appendDuringReplay = false;
          // While replay is mid-await, the running stream appends another part.
          await liveRef.current.push({ type: "text-delta", text: "b" });
        }
        return 1;
      },
    };
    const harness = createLiveStreamHarness({ tokenTracker });
    const workspaceId = "ws-replay-snapshot";
    const live = await harness.start({ workspaceId, messageId: "msg-1" });
    liveRef.current = live;
    await live.push({ type: "text-delta", text: "a" });

    appendDuringReplay = true;
    await harness.streamManager.replayStream(workspaceId);

    const replayed = harness.events.filter(isReplay);
    expect(replayed[0]?.type).toBe("stream-start");
    // If replayStream iterates the live array, it would also emit "b".
    expect(eventsOfType(replayed, "stream-delta").map((event) => event.delta)).toEqual(["a"]);
    // The live stream did append "b" while the replay was running.
    const liveDeltas = eventsOfType(harness.events, "stream-delta").filter((e) => !isReplay(e));
    expect(liveDeltas.map((event) => event.delta)).toEqual(["a", "b"]);
    await live.finish();
  });

  test("replayStream filters output-available tool parts using completion timestamps", async () => {
    const harness = createLiveStreamHarness();
    const workspaceId = "ws-replay-tool-filter";
    const live = await harness.start({ workspaceId, messageId: "msg-tools" });
    // Both parts land before either completes, so tool-new's part timestamp is
    // older than the cursor and only its completion time is newer.
    await live.push(
      toolCall("tool-old"),
      toolCall("tool-new"),
      toolResult("tool-old"),
      toolResult("tool-new")
    );
    const cursor = eventsOfType(harness.events, "tool-call-end").find(
      (event) => event.toolCallId === "tool-old"
    )?.timestamp;
    if (cursor == null) throw new Error("Expected tool-old completion");
    const replayStart = harness.events.length;

    await harness.streamManager.replayStream(workspaceId, { afterTimestamp: cursor });

    const replayedEnds = eventsOfType(harness.events.slice(replayStart), "tool-call-end");
    expect(replayedEnds.every(isReplay)).toBe(true);
    expect(replayedEnds.map((event) => event.toolCallId)).toEqual(["tool-new"]);
    await live.finish();
  });

  test("replayStream replays queued tool parts whose execute() began after the cursor", async () => {
    const harness = createLiveStreamHarness();
    const workspaceId = "ws-replay-exec-start";
    const bash = tool({ inputSchema: z.object({}), execute: () => ({ ok: true }) });
    const live = await harness.start({
      workspaceId,
      messageId: "msg-exec-start",
      tools: { bash },
    });
    // Both calls are queued before the cursor; only one begins execute() after it.
    await live.push(toolCall("tool-still-queued"), toolCall("tool-started-after-cursor"));
    const cursor = eventsOfType(harness.events, "tool-call-start").at(-1)?.timestamp;
    if (cursor == null) throw new Error("Expected tool-call-start");
    const executionOptions: ToolExecutionOptions<unknown> = {
      toolCallId: "tool-started-after-cursor",
      messages: [],
      context: undefined,
    };
    await harness.tools().bash.execute?.({ script: "true" }, executionOptions);
    const executionStart = eventsOfType(harness.events, "tool-call-execution-start")[0]?.timestamp;
    if (executionStart == null) throw new Error("Expected tool-call-execution-start");
    expect(executionStart).toBeGreaterThan(cursor);
    const replayStart = harness.events.length;

    await harness.streamManager.replayStream(workspaceId, { afterTimestamp: cursor });

    // Replayed with the enriched executionStartedAt so the renderer can start the elapsed timer.
    const replayedStarts = eventsOfType(harness.events.slice(replayStart), "tool-call-start");
    expect(replayedStarts.every(isReplay)).toBe(true);
    expect(
      replayedStarts.map((event) => ({
        toolCallId: event.toolCallId,
        executionStartedAt: event.executionStartedAt,
      }))
    ).toEqual([{ toolCallId: "tool-started-after-cursor", executionStartedAt: executionStart }]);
    await live.finish();
  });

  /** Two steps, so the last step's usage differs from the stream's cumulative usage. */
  async function startTwoStepUsageStream(workspaceId: string) {
    const harness = createLiveStreamHarness();
    const live = await harness.start({
      workspaceId,
      messageId: `${workspaceId}-message`,
      initialMetadata: { costsIncluded: true },
    });
    await live.push(
      { type: "text-delta", text: "hello" },
      {
        type: "finish-step",
        usage: { inputTokens: 34, outputTokens: 8, totalTokens: 42 },
        providerMetadata: { anthropic: { cacheCreationInputTokens: 9 } },
      },
      {
        type: "finish-step",
        usage: { inputTokens: 21, outputTokens: 3, totalTokens: 24 },
        providerMetadata: { anthropic: { cacheReadInputTokens: 2 } },
      }
    );
    return { harness, live };
  }

  test("replayStream emits replay usage-delta from tracked step/cumulative usage", async () => {
    const workspaceId = "ws-replay-usage";
    const { harness, live } = await startTwoStepUsageStream(workspaceId);
    const liveUsage = eventsOfType(harness.events, "usage-delta");
    expect(liveUsage).toHaveLength(2);
    const replayStart = harness.events.length;

    await harness.streamManager.replayStream(workspaceId);

    const replayedUsage = eventsOfType(harness.events.slice(replayStart), "usage-delta");
    expect(replayedUsage).toHaveLength(1);
    expect(replayedUsage[0]?.replay).toBe(true);
    expect(replayedUsage[0]?.usage).toMatchObject({ inputTokens: 21, outputTokens: 3 });
    expect(replayedUsage[0]?.providerMetadata).toMatchObject({
      anthropic: { cacheReadInputTokens: 2 },
    });
    expect(replayedUsage[0]?.cumulativeUsage).toMatchObject({ inputTokens: 55, outputTokens: 11 });
    expect(replayedUsage[0]?.cumulativeProviderMetadata).toMatchObject({
      anthropic: { cacheCreationInputTokens: 9 },
      mux: { costsIncluded: true },
    });
    // Replay re-delivers exactly the latest live usage snapshot.
    const { replay: _replay, ...replayedFields } = replayedUsage[0];
    expect(replayedFields).toEqual(liveUsage[1]);
    await live.finish();
  });

  test("replayStream skips replay usage-delta for incremental afterTimestamp replays", async () => {
    const workspaceId = "ws-replay-usage-incremental";
    const { harness, live } = await startTwoStepUsageStream(workspaceId);
    const replayStart = harness.events.length;

    await harness.streamManager.replayStream(workspaceId, { afterTimestamp: 0 });

    // The incremental replay ran (it re-sent the text part) but sent no usage snapshot.
    const replayed = harness.events.slice(replayStart);
    expect(eventsOfType(replayed, "stream-delta")).toHaveLength(1);
    expect(eventsOfType(replayed, "usage-delta")).toHaveLength(0);
    await live.finish();
  });
});

describe("StreamManager - getStreamInfo", () => {
  test("returns startTime so reconnect cursors can preserve live-only boundaries", async () => {
    const harness = createLiveStreamHarness();
    const workspaceId = "ws-get-stream-info";
    const before = Date.now();
    const live = await harness.start({
      workspaceId,
      messageId: "msg-starting",
      initialMetadata: { systemMessageTokens: 2_048 },
    });
    const after = Date.now();

    const streamInfo = harness.streamManager.getStreamInfo(workspaceId);

    expect(streamInfo?.messageId).toBe("msg-starting");
    expect(streamInfo?.startTime).toBeGreaterThanOrEqual(before);
    expect(streamInfo?.startTime).toBeLessThanOrEqual(after);
    expect(streamInfo?.initialMetadata?.systemMessageTokens).toBe(2_048);
    expect(streamInfo?.currentStepStartIndex).toBe(0);
    expect(streamInfo?.stepStartIndices).toEqual([0]);
    streamInfo?.stepStartIndices.push(5);
    expect(harness.streamManager.getStreamInfo(workspaceId)?.stepStartIndices).toEqual([0]);
    await live.push({ type: "text-delta", text: "done" });
    await live.finish();
  });
});
