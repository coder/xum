import { describe, test, expect, setSystemTime } from "bun:test";
import { tool, type Tool, type ToolExecutionOptions } from "ai";
import { z } from "zod";
import { ToolCallStartEventSchema } from "@/common/orpc/schemas/stream";
import type { WorkflowRunRecord } from "@/common/types/workflow";
import type { TurnEngineEvent, TurnExecutionOptions } from "./streamManager";
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

function dynamicToolCall(toolCallId: string, toolName: string, input: unknown = {}) {
  return { type: "tool-call", toolCallId, toolName, input };
}

/** The live parts of the workspace's active stream (getStreamInfo returns the live array). */
function liveParts(harness: ReturnType<typeof createLiveStreamHarness>, workspaceId: string) {
  const parts = harness.streamManager.getStreamInfo(workspaceId)?.parts;
  if (parts == null) throw new Error("Expected an active stream");
  return parts as Array<Record<string, unknown>>;
}

function createWorkflowRunRecordForTests(runId: string, workspaceId: string): WorkflowRunRecord {
  return {
    id: runId,
    workspaceId,
    workflow: {
      name: "deep-research",
      description: "test workflow",
      scope: "project",
      executable: true,
    },
    source: "export default function workflow() { return { reportMarkdown: 'x'.repeat(64) }; }",
    sourceHash: "sha256:test",
    args: {},
    status: "running",
    createdAt: "2026-05-29T00:00:00.000Z",
    updatedAt: "2026-05-29T00:00:01.000Z",
    events: [],
    steps: [],
  };
}

describe("StreamManager - event sink rejection containment", () => {
  test("a rejecting async event sink does not become an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const streamManager = createStreamManagerForTests(historyService, {
        eventSink: () => Promise.reject(new Error("sink boom")),
        streamText: fakeStreamText(() =>
          createStreamResultForTests(
            (async function* () {
              await Promise.resolve();
              yield { type: "text-delta", text: "hello" };
              yield { type: "finish", finishReason: "stop" };
            })()
          )
        ),
      });
      const workspaceId = "sink-rejection-workspace";
      await appendPartialAssistantForTests(workspaceId, "sink-rejection-message", 1);
      // Every lifecycle event (stream-start, deltas, stream-end) goes to the rejecting sink.
      const result = await streamManager.startStream(
        testStartOptions({
          workspaceId,
          messageId: "sink-rejection-message",
          model: createTestLanguageModel(),
          providedRuntimeTempDir: "",
        })
      );
      if (!result.success) throw new Error("Expected stream to start");
      await result.data.completion;
      // A macrotask so an uncontained rejection would surface before asserting.
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("StreamManager - workflow run attachments", () => {
  test("persists attached workflow run metadata to partial immediately", async () => {
    const harness = createLiveStreamHarness();
    const workspaceId = "workflow-attachment-workspace";
    const messageId = "workflow-attachment-message";
    const live = await harness.start({ workspaceId, messageId });
    await live.push(
      dynamicToolCall("workflow-call-1", "workflow_run", { name: "deep-research", args: {} })
    );
    const timestamp = Date.now();

    const attached = await harness.streamManager.attachWorkflowRunToToolCall({
      type: "workflow-run-attached",
      workspaceId,
      messageId,
      toolCallId: "workflow-call-1",
      runId: "wfr_attached",
      timestamp,
    });

    expect(attached).toBe(true);
    const partial = await historyService.readPartial(workspaceId);
    const part = partial?.parts[0];
    if (part?.type !== "dynamic-tool") {
      throw new Error("Expected workflow tool part in persisted partial");
    }
    expect(part.workflowRun).toEqual({ runId: "wfr_attached", timestamp });
    await live.finish();
  });

  test("persists workflow attachments onto nested kernel tool calls", async () => {
    const harness = createLiveStreamHarness();
    const workspaceId = "workflow-nested-attachment-workspace";
    const messageId = "workflow-nested-attachment-message";
    const live = await harness.start({ workspaceId, messageId });
    await live.push(
      dynamicToolCall("code-exec-1", "code_execution", { code: "mux.workflow_run({...})" })
    );
    const timestamp = Date.now();
    harness.streamManager.emitNestedToolEvent(
      { workspaceId, messageId, token: "test" },
      {
        type: "tool-call-start",
        callId: "nested-workflow-1",
        toolName: "workflow_run",
        // Kernel bounding replaced the launch args with a marker; the
        // attachment is the only durable run identity for this call.
        args: { __kernelBounded: true, bytes: 18_457, preview: "{…}" },
        parentToolCallId: "code-exec-1",
        startTime: timestamp,
      }
    );

    const attached = await harness.streamManager.attachWorkflowRunToToolCall({
      type: "workflow-run-attached",
      workspaceId,
      messageId,
      toolCallId: "nested-workflow-1",
      runId: "wfr_nested",
      // The live event carries the full run record (large source/args),
      // exactly what kernel bounding keeps out of the nested record.
      run: createWorkflowRunRecordForTests("wfr_nested", workspaceId),
      timestamp: timestamp + 1,
    });

    expect(attached).toBe(true);
    const partial = await historyService.readPartial(workspaceId);
    const part = partial?.parts[0];
    if (part?.type !== "dynamic-tool") {
      throw new Error("Expected code_execution tool part in persisted partial");
    }
    // Identity only: persisting the run record (source, args) would bypass the
    // kernel record caps via partial.json.
    expect(part.nestedCalls?.[0]?.workflowRun).toEqual({
      runId: "wfr_nested",
      timestamp: timestamp + 1,
    });
    await live.finish();
  });

  test("persists workflow attachments that arrive before the tool part", async () => {
    const harness = createLiveStreamHarness();
    const workspaceId = "workflow-attachment-race-workspace";
    const messageId = "workflow-attachment-race-message";
    const live = await harness.start({ workspaceId, messageId });
    const timestamp = Date.now();

    const attached = await harness.streamManager.attachWorkflowRunToToolCall({
      type: "workflow-run-attached",
      workspaceId,
      messageId,
      toolCallId: "workflow-call-race",
      runId: "wfr_race",
      timestamp,
    });

    expect(attached).toBe(true);
    expect(await historyService.readPartial(workspaceId)).toBeNull();
    const pushStart = harness.events.length;

    await live.push(
      dynamicToolCall("workflow-call-race", "workflow_run", { name: "deep-research", args: {} })
    );

    expect(eventsOfType(harness.events.slice(pushStart), "workflow-run-attached")).toEqual([
      {
        type: "workflow-run-attached",
        workspaceId,
        messageId,
        toolCallId: "workflow-call-race",
        runId: "wfr_race",
        timestamp,
      },
    ]);
    const partial = await historyService.readPartial(workspaceId);
    const part = partial?.parts[0];
    if (part?.type !== "dynamic-tool") {
      throw new Error("Expected workflow tool part in persisted partial");
    }
    expect(part.workflowRun).toEqual({ runId: "wfr_race", timestamp });
    await live.finish();
  });
});

describe("StreamManager - nested kernel call race and replay", () => {
  test("buffers nested events that beat the parent part and persists them (with run identity) on merge", async () => {
    const harness = createLiveStreamHarness();
    const workspaceId = "nested-race-workspace";
    const messageId = "nested-race-message";
    const live = await harness.start({ workspaceId, messageId });
    const timestamp = Date.now();

    // execute() wins the race: nested start arrives before the parent part exists.
    harness.streamManager.emitNestedToolEvent(
      { workspaceId, messageId, token: "test" },
      {
        type: "tool-call-start",
        callId: "nested-race-workflow",
        toolName: "workflow_run",
        args: { __kernelBounded: true, bytes: 18_457, preview: "{…}" },
        parentToolCallId: "code-exec-race",
        startTime: timestamp,
      }
    );

    // The workflow attachment lands while the nested record is still buffered.
    const attached = await harness.streamManager.attachWorkflowRunToToolCall({
      type: "workflow-run-attached",
      workspaceId,
      messageId,
      toolCallId: "nested-race-workflow",
      runId: "wfr_race_nested",
      run: createWorkflowRunRecordForTests("wfr_race_nested", workspaceId),
      timestamp: timestamp + 1,
    });
    expect(attached).toBe(true);
    // Nothing persisted yet: the parent part has not landed.
    expect(await historyService.readPartial(workspaceId)).toBeNull();

    // The renderer dropped the original raced events, so the merge must
    // re-deliver them once the parent part exists.
    const pushStart = harness.events.length;
    await live.push(
      dynamicToolCall("code-exec-race", "code_execution", { code: "mux.workflow_run({...})" })
    );
    const merged = harness.events.slice(pushStart);
    const reEmittedStart = eventsOfType(merged, "tool-call-start").find(
      (e) => e.toolCallId === "nested-race-workflow"
    );
    expect(reEmittedStart?.parentToolCallId).toBe("code-exec-race");
    expect(
      eventsOfType(merged, "workflow-run-attached").some(
        (e) => e.toolCallId === "nested-race-workflow"
      )
    ).toBe(true);

    const partial = await historyService.readPartial(workspaceId);
    const part = partial?.parts[0];
    if (part?.type !== "dynamic-tool") {
      throw new Error("Expected code_execution tool part in persisted partial");
    }
    expect(part.nestedCalls).toHaveLength(1);
    expect(part.nestedCalls?.[0]?.toolCallId).toBe("nested-race-workflow");
    // Run identity only (no run record), same bound as the direct attach path.
    expect(part.nestedCalls?.[0]?.workflowRun).toEqual({
      runId: "wfr_race_nested",
      timestamp: timestamp + 1,
    });
    await live.finish();
  });

  test("replays persisted nested calls (start, attachment, end) with the parent part", async () => {
    const harness = createLiveStreamHarness();
    const workspaceId = "nested-replay-workspace";
    const messageId = "nested-replay-message";
    const scope = { workspaceId, messageId, token: "test" };
    const live = await harness.start({ workspaceId, messageId });
    await live.push(
      dynamicToolCall("code-exec-replay", "code_execution", { code: "mux.workflow_run({...})" })
    );
    const timestamp = Date.now();
    const nested = {
      callId: "nested-replay-workflow",
      toolName: "workflow_run",
      args: { __kernelBounded: true, bytes: 18_457, preview: "{…}" },
      parentToolCallId: "code-exec-replay",
      startTime: timestamp,
    };
    harness.streamManager.emitNestedToolEvent(scope, { ...nested, type: "tool-call-start" });
    await harness.streamManager.attachWorkflowRunToToolCall({
      type: "workflow-run-attached",
      workspaceId,
      messageId,
      toolCallId: "nested-replay-workflow",
      runId: "wfr_replay",
      timestamp: timestamp + 2,
    });
    harness.streamManager.emitNestedToolEvent(scope, {
      ...nested,
      type: "tool-call-end",
      endTime: timestamp + 1,
      result: { __kernelBounded: true, runId: "wfr_replay", status: "running" },
    });
    const replayStart = harness.events.length;

    await harness.streamManager.replayStream(workspaceId);

    const replayed = harness.events.slice(replayStart);
    const nestedStart = eventsOfType(replayed, "tool-call-start").find(
      (e) => e.toolCallId === "nested-replay-workflow"
    );
    expect(nestedStart?.parentToolCallId).toBe("code-exec-replay");
    expect(nestedStart?.replay).toBe(true);
    const nestedAttach = eventsOfType(replayed, "workflow-run-attached").find(
      (e) => e.toolCallId === "nested-replay-workflow"
    );
    expect(nestedAttach?.runId).toBe("wfr_replay");
    const nestedEnd = eventsOfType(replayed, "tool-call-end").find(
      (e) => e.toolCallId === "nested-replay-workflow"
    );
    expect(nestedEnd?.parentToolCallId).toBe("code-exec-replay");
    await live.finish();
  });

  /** Starts a stream whose only part is a code_execution parent; returns its part timestamp. */
  async function startNestedParentStream(workspaceId: string) {
    const harness = createLiveStreamHarness();
    const messageId = `${workspaceId}-message`;
    const scope = { workspaceId, messageId, token: "test" };
    const live = await harness.start({ workspaceId, messageId });
    await live.push(dynamicToolCall("code-exec", "code_execution", { code: "…" }));
    const parentTimestamp = eventsOfType(harness.events, "tool-call-start")[0]?.timestamp;
    if (parentTimestamp == null) throw new Error("Expected the parent tool-call-start");
    const emitNested = (callId: string, startTime: number, endTime?: number): void => {
      const nested = { callId, toolName: "workflow_run", args: {}, parentToolCallId: "code-exec" };
      harness.streamManager.emitNestedToolEvent(scope, {
        ...nested,
        type: "tool-call-start",
        startTime,
      });
      if (endTime != null) {
        harness.streamManager.emitNestedToolEvent(scope, {
          ...nested,
          type: "tool-call-end",
          startTime,
          endTime,
          result: { runId: "wfr_done" },
        });
      }
    };
    /** Nested call ids the incremental replay after `cursor` re-sent. */
    const replayedNestedStarts = async (cursor: number): Promise<string[]> => {
      const replayStart = harness.events.length;
      await harness.streamManager.replayStream(workspaceId, { afterTimestamp: cursor });
      return eventsOfType(harness.events.slice(replayStart), "tool-call-start")
        .filter((event) => event.parentToolCallId === "code-exec")
        .map((event) => event.toolCallId);
    };
    return { harness, live, parentTimestamp, emitNested, replayedNestedStarts };
  }

  test("incremental replay notices a nested call that completed while disconnected", async () => {
    const { live, parentTimestamp, emitNested, replayedNestedStarts } =
      await startNestedParentStream("nested-replay-completion-workspace");
    // Both nested starts predate the cursor; only their completions differ.
    const cursor = parentTimestamp + 1_000;

    // Completed before the cursor: nothing fresh, no replay.
    emitNested("nested-completed-before", parentTimestamp, cursor - 10);
    expect(await replayedNestedStarts(cursor)).toEqual([]);

    // Completed after the cursor: the parent (with its nested rows) must replay.
    emitNested("nested-completed-after", parentTimestamp, cursor + 50);
    expect(await replayedNestedStarts(cursor)).toContain("nested-completed-after");
    await live.finish();
  });

  test("emitNestedToolEvent records nested completion timestamps", async () => {
    const { harness, live, parentTimestamp, emitNested } = await startNestedParentStream(
      "nested-completion-record-workspace"
    );

    emitNested("nested-ts", parentTimestamp, parentTimestamp + 5);

    const streamInfo = harness.streamManager.getStreamInfo("nested-completion-record-workspace");
    expect(streamInfo?.toolCompletionTimestamps.get("nested-ts")).toBe(parentTimestamp + 5);
    await live.finish();
  });

  test("incremental replay keeps a parent whose only fresh activity is nested", async () => {
    const { live, parentTimestamp, emitNested, replayedNestedStarts } =
      await startNestedParentStream("nested-replay-cursor-workspace");

    // The parent part predates the reconnect cursor, but the nested workflow started after it.
    emitNested("nested-cursor-workflow", parentTimestamp + 100);

    expect(await replayedNestedStarts(parentTimestamp + 50)).toEqual(["nested-cursor-workflow"]);
    await live.finish();
  });
});

describe("StreamManager - nested tool call normalization", () => {
  test("normalizes zero-arg nested calls to {} for the persisted record and the wire event", async () => {
    const harness = createLiveStreamHarness();
    const workspaceId = "nested-normalize-workspace";
    const messageId = "nested-normalize-message";
    const live = await harness.start({ workspaceId, messageId });
    await live.push(
      dynamicToolCall("parent-1", "code_execution", { code: "mux.linear_list_teams()" })
    );
    const emitStart = harness.events.length;

    harness.streamManager.emitNestedToolEvent(
      { workspaceId, messageId, token: "test" },
      {
        type: "tool-call-start",
        callId: "nested-1",
        toolName: "linear_list_teams",
        // Zero-argument guest call: JSON cannot represent undefined, so both the
        // persisted record and the wire event must carry {} instead.
        args: undefined,
        parentToolCallId: "parent-1",
        startTime: Date.now(),
      }
    );

    const parentPart = liveParts(harness, workspaceId)[0] as {
      nestedCalls?: Array<{ input?: unknown }>;
    };
    expect(parentPart.nestedCalls).toHaveLength(1);
    expect(parentPart.nestedCalls?.[0]?.input).toEqual({});

    // The live event must survive oRPC output validation (args key required).
    const events = harness.events.slice(emitStart);
    expect(events).toHaveLength(1);
    expect(ToolCallStartEventSchema.safeParse(events[0]).success).toBe(true);
    expect((events[0] as { args?: unknown }).args).toEqual({});
    await live.finish();
  });
});

describe("StreamManager - tool execution start timing", () => {
  const bash = tool({ inputSchema: z.object({}), execute: () => ({ ok: true }) });

  async function executeTool(
    harness: ReturnType<typeof createLiveStreamHarness>,
    toolCallId: string
  ): Promise<void> {
    const options: ToolExecutionOptions<unknown> = { toolCallId, messages: [], context: undefined };
    await harness.tools().bash.execute?.({}, options);
  }

  test("stamps executionStartedAt and emits tool-call-execution-start when the part already exists", async () => {
    const harness = createLiveStreamHarness();
    const workspaceId = "execution-start-workspace";
    const messageId = "execution-start-message";
    const live = await harness.start({ workspaceId, messageId, tools: { bash } });

    // Freeze the wall clock so a raw Date.now() execution start would equal the
    // tool-call part timestamp; reconnect replay's `executionStartedAt > cursor`
    // repair predicate would then never fire for a cursor at that part.
    setSystemTime(new Date(Date.now()));
    let partTimestamp: number | undefined;
    try {
      await live.push(dynamicToolCall("tool-call-1", "bash"));
      partTimestamp = eventsOfType(harness.events, "tool-call-start")[0]?.timestamp;
      await executeTool(harness, "tool-call-1");
    } finally {
      setSystemTime();
    }

    const events = eventsOfType(harness.events, "tool-call-execution-start");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "tool-call-execution-start",
      workspaceId,
      messageId,
      toolCallId: "tool-call-1",
    });
    // Cursor-monotonic: strictly after the tool-call part timestamp even when the wall
    // clock has not advanced past it.
    if (partTimestamp == null) throw new Error("Expected tool-call-start");
    expect(events[0].timestamp).toBeGreaterThan(partTimestamp);
    expect(liveParts(harness, workspaceId)[0].executionStartedAt).toBe(events[0].timestamp);
    await live.finish();
  });

  test("applies execution starts that arrive before the tool part lands", async () => {
    const harness = createLiveStreamHarness();
    const workspaceId = "execution-start-race-workspace";
    const messageId = "execution-start-race-message";
    const live = await harness.start({ workspaceId, messageId, tools: { bash } });

    // execute() wins the race: no part yet, so the start is parked as pending.
    await executeTool(harness, "tool-call-race");
    expect(eventsOfType(harness.events, "tool-call-execution-start")).toHaveLength(0);

    await live.push(dynamicToolCall("tool-call-race", "bash"));

    const events = eventsOfType(harness.events, "tool-call-execution-start");
    expect(events).toHaveLength(1);
    expect(events[0].toolCallId).toBe("tool-call-race");
    expect(liveParts(harness, workspaceId)[0].executionStartedAt).toBe(events[0].timestamp);
    await live.finish();
  });
});
