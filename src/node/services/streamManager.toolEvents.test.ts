import { describe, test, expect } from "bun:test";
import { ToolCallStartEventSchema } from "@/common/orpc/schemas/stream";
import type {
  CompletedMessagePart,
  ToolCallEndEvent,
  ToolCallExecutionStartEvent,
  ToolCallStartEvent,
  WorkflowRunAttachedEvent,
} from "@/common/types/stream";
import type { WorkflowRunRecord } from "@/common/types/workflow";
import { StreamManager } from "./streamManager";
import {
  createStreamManagerForTests,
  engineInternals,
  fakeStreamText,
  onTurnEngineEvent,
} from "./streamManager.testHarness";
import {
  installStreamManagerTestHistory,
  historyService,
  createTestLanguageModel,
  testStartOptions,
  appendPartialAssistantForTests,
  createStreamResultForTests,
  createStreamInfoForTests,
} from "./streamManager.suite.testHarness";

installStreamManagerTestHistory();

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
    const streamManager = new StreamManager(historyService);
    const workspaceId = "workflow-attachment-workspace";
    const messageId = "workflow-attachment-message";
    const timestamp = Date.now();
    const streamInfo = createStreamInfoForTests({
      messageId,
      lastPartialWriteTime: timestamp,
      pendingWorkflowRunAttachments: undefined,
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "workflow-call-1",
          toolName: "workflow_run",
          input: { name: "deep-research", args: {} },
          state: "input-available",
          timestamp,
        },
      ],
    });

    engineInternals(streamManager).workspaceStreams.set(workspaceId, streamInfo);

    const attached = await streamManager.attachWorkflowRunToToolCall({
      type: "workflow-run-attached",
      workspaceId,
      messageId,
      toolCallId: "workflow-call-1",
      runId: "wfr_attached",
      timestamp: timestamp + 1,
    });

    expect(attached).toBe(true);
    const partial = await historyService.readPartial(workspaceId);
    const part = partial?.parts[0];
    if (part?.type !== "dynamic-tool") {
      throw new Error("Expected workflow tool part in persisted partial");
    }
    expect(part.workflowRun).toEqual({
      runId: "wfr_attached",
      timestamp: timestamp + 1,
    });
  });

  test("persists workflow attachments onto nested kernel tool calls", async () => {
    const streamManager = new StreamManager(historyService);
    const workspaceId = "workflow-nested-attachment-workspace";
    const messageId = "workflow-nested-attachment-message";
    const timestamp = Date.now();
    const streamInfo = createStreamInfoForTests({
      messageId,
      lastPartialWriteTime: timestamp,
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "code-exec-1",
          toolName: "code_execution",
          input: { code: "mux.workflow_run({...})" },
          state: "input-available",
          timestamp,
          nestedCalls: [
            {
              toolCallId: "nested-workflow-1",
              toolName: "workflow_run",
              // Kernel bounding replaced the launch args with a marker; the
              // attachment is the only durable run identity for this call.
              input: { __kernelBounded: true, bytes: 18_457, preview: "{…}" },
              state: "input-available",
              timestamp,
            },
          ],
        },
      ],
    });

    engineInternals(streamManager).workspaceStreams.set(workspaceId, streamInfo);

    const attached = await streamManager.attachWorkflowRunToToolCall({
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
    // The attachment landed on the nested record, not the pending map.
    expect((streamInfo.pendingWorkflowRunAttachments as Map<string, unknown>).size).toBe(0);
  });

  test("persists workflow attachments that arrive before the tool part", async () => {
    const streamManager = new StreamManager(historyService);
    const workspaceId = "workflow-attachment-race-workspace";
    const messageId = "workflow-attachment-race-message";
    const timestamp = Date.now();
    const streamInfo = createStreamInfoForTests({
      messageId,
      lastPartialWriteTime: timestamp,
      parts: [],
    });

    engineInternals(streamManager).workspaceStreams.set(workspaceId, streamInfo);

    const attached = await streamManager.attachWorkflowRunToToolCall({
      type: "workflow-run-attached",
      workspaceId,
      messageId,
      toolCallId: "workflow-call-race",
      runId: "wfr_race",
      timestamp: timestamp + 1,
    });

    expect(attached).toBe(true);
    expect(await historyService.readPartial(workspaceId)).toBeNull();

    const appendPartAndEmit = engineInternals(streamManager).appendPartAndEmit;

    const replayedAttachments: WorkflowRunAttachedEvent[] = [];
    onTurnEngineEvent(streamManager, "workflow-run-attached", (event: WorkflowRunAttachedEvent) => {
      replayedAttachments.push(event);
    });

    await appendPartAndEmit.call(
      streamManager,
      workspaceId,
      streamInfo,
      {
        type: "dynamic-tool",
        toolCallId: "workflow-call-race",
        toolName: "workflow_run",
        input: { name: "deep-research", args: {} },
        state: "input-available",
        timestamp: timestamp + 2,
      },
      false
    );

    expect(replayedAttachments).toEqual([
      {
        type: "workflow-run-attached",
        workspaceId,
        messageId,
        toolCallId: "workflow-call-race",
        runId: "wfr_race",
        timestamp: timestamp + 1,
      },
    ]);

    const partial = await historyService.readPartial(workspaceId);
    const part = partial?.parts[0];
    if (part?.type !== "dynamic-tool") {
      throw new Error("Expected workflow tool part in persisted partial");
    }
    expect(part.workflowRun).toEqual({
      runId: "wfr_race",
      timestamp: timestamp + 1,
    });
  });
});

describe("StreamManager - nested kernel call race and replay", () => {
  test("buffers nested events that beat the parent part and persists them (with run identity) on merge", async () => {
    const streamManager = new StreamManager(historyService);
    const workspaceId = "nested-race-workspace";
    const messageId = "nested-race-message";
    const timestamp = Date.now();
    const streamInfo = createStreamInfoForTests({
      messageId,
      lastPartialWriteTime: timestamp,
      parts: [],
    });
    engineInternals(streamManager).workspaceStreams.set(workspaceId, streamInfo);

    // execute() wins the race: nested start arrives before the parent part exists.
    streamManager.emitNestedToolEvent(
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
    const attached = await streamManager.attachWorkflowRunToToolCall({
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

    const appendPartAndEmit = engineInternals(streamManager).appendPartAndEmit;
    // The renderer dropped the original raced events, so the merge must
    // re-deliver them once the parent part exists.
    const reEmittedStarts: ToolCallStartEvent[] = [];
    const reEmittedAttachments: WorkflowRunAttachedEvent[] = [];
    onTurnEngineEvent(streamManager, "tool-call-start", (event) => reEmittedStarts.push(event));
    onTurnEngineEvent(streamManager, "workflow-run-attached", (event) =>
      reEmittedAttachments.push(event)
    );
    await appendPartAndEmit.call(
      streamManager,
      workspaceId,
      streamInfo,
      {
        type: "dynamic-tool",
        toolCallId: "code-exec-race",
        toolName: "code_execution",
        input: { code: "mux.workflow_run({...})" },
        state: "input-available",
        timestamp: timestamp + 2,
      },
      false
    );
    const reEmittedStart = reEmittedStarts.find((e) => e.toolCallId === "nested-race-workflow");
    expect(reEmittedStart?.parentToolCallId).toBe("code-exec-race");
    expect(reEmittedAttachments.some((e) => e.toolCallId === "nested-race-workflow")).toBe(true);

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
    // Both holding areas were consumed.
    expect((streamInfo.pendingNestedCalls as Map<string, unknown>).size).toBe(0);
    expect((streamInfo.pendingWorkflowRunAttachments as Map<string, unknown>).size).toBe(0);
  });

  test("replays persisted nested calls (start, attachment, end) with the parent part", async () => {
    const streamManager = new StreamManager(historyService);
    const workspaceId = "nested-replay-workspace";
    const messageId = "nested-replay-message";
    const timestamp = Date.now();
    const streamInfo = createStreamInfoForTests({
      messageId,
      lastPartialWriteTime: timestamp,
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "code-exec-replay",
          toolName: "code_execution",
          input: { code: "mux.workflow_run({...})" },
          state: "input-available",
          timestamp,
          nestedCalls: [
            {
              toolCallId: "nested-replay-workflow",
              toolName: "workflow_run",
              input: { __kernelBounded: true, bytes: 18_457, preview: "{…}" },
              state: "output-available",
              output: { __kernelBounded: true, runId: "wfr_replay", status: "running" },
              timestamp: timestamp + 1,
              workflowRun: { runId: "wfr_replay", timestamp: timestamp + 2 },
            },
          ],
        },
      ],
    });
    engineInternals(streamManager).workspaceStreams.set(workspaceId, streamInfo);

    const starts: ToolCallStartEvent[] = [];
    const attachments: WorkflowRunAttachedEvent[] = [];
    const ends: ToolCallEndEvent[] = [];
    onTurnEngineEvent(streamManager, "tool-call-start", (event) => starts.push(event));
    onTurnEngineEvent(streamManager, "workflow-run-attached", (event) => attachments.push(event));
    onTurnEngineEvent(streamManager, "tool-call-end", (event) => ends.push(event));

    await streamManager.replayStream(workspaceId);

    const nestedStart = starts.find((e) => e.toolCallId === "nested-replay-workflow");
    expect(nestedStart?.parentToolCallId).toBe("code-exec-replay");
    expect(nestedStart?.replay).toBe(true);
    const nestedAttach = attachments.find((e) => e.toolCallId === "nested-replay-workflow");
    expect(nestedAttach?.runId).toBe("wfr_replay");
    const nestedEnd = ends.find((e) => e.toolCallId === "nested-replay-workflow");
    expect(nestedEnd?.parentToolCallId).toBe("code-exec-replay");
  });

  test("incremental replay notices a nested call that completed while disconnected", async () => {
    const streamManager = new StreamManager(historyService);
    const workspaceId = "nested-replay-completion-workspace";
    const messageId = "nested-replay-completion-message";
    const timestamp = Date.now();
    const makeStreamInfo = (completedAt: number) =>
      createStreamInfoForTests({
        messageId,
        lastPartialWriteTime: timestamp,
        toolCompletionTimestamps: new Map([["nested-completed-workflow", completedAt]]),
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "code-exec-completion",
            toolName: "code_execution",
            input: { code: "mux.workflow_run({...})" },
            state: "input-available",
            timestamp,
            nestedCalls: [
              {
                toolCallId: "nested-completed-workflow",
                toolName: "workflow_run",
                input: {},
                state: "output-available",
                output: { runId: "wfr_done" },
                // Start predates the cursor; only the completion is fresh.
                timestamp,
              },
            ],
          },
        ],
      });
    const cursor = timestamp + 50;

    // Completed after the cursor: the parent must replay.
    engineInternals(streamManager).workspaceStreams.set(
      workspaceId,
      makeStreamInfo(timestamp + 100)
    );
    const starts: ToolCallStartEvent[] = [];
    onTurnEngineEvent(streamManager, "tool-call-start", (event) => starts.push(event));
    await streamManager.replayStream(workspaceId, { afterTimestamp: cursor });
    expect(starts.some((e) => e.toolCallId === "nested-completed-workflow")).toBe(true);

    // Completed before the cursor: nothing fresh, no replay.
    engineInternals(streamManager).workspaceStreams.set(
      workspaceId,
      makeStreamInfo(timestamp + 10)
    );
    starts.length = 0;
    await streamManager.replayStream(workspaceId, { afterTimestamp: cursor });
    expect(starts.some((e) => e.toolCallId === "nested-completed-workflow")).toBe(false);
  });

  test("emitNestedToolEvent records nested completion timestamps", () => {
    const streamManager = new StreamManager(historyService);
    const workspaceId = "nested-completion-record-workspace";
    const messageId = "nested-completion-record-message";
    const timestamp = Date.now();
    const streamInfo = createStreamInfoForTests({
      messageId,
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "code-exec-ts",
          toolName: "code_execution",
          input: {},
          state: "input-available",
          timestamp,
          nestedCalls: [
            {
              toolCallId: "nested-ts",
              toolName: "bash",
              input: {},
              state: "input-available",
              timestamp,
            },
          ],
        },
      ],
    });
    engineInternals(streamManager).workspaceStreams.set(workspaceId, streamInfo);

    streamManager.emitNestedToolEvent(
      { workspaceId, messageId, token: "test" },
      {
        type: "tool-call-end",
        callId: "nested-ts",
        toolName: "bash",
        args: {},
        parentToolCallId: "code-exec-ts",
        startTime: timestamp,
        endTime: timestamp + 5,
        result: { ok: true },
      }
    );

    expect((streamInfo.toolCompletionTimestamps as Map<string, number>).get("nested-ts")).toBe(
      timestamp + 5
    );
  });

  test("incremental replay keeps a parent whose only fresh activity is nested", async () => {
    const streamManager = new StreamManager(historyService);
    const workspaceId = "nested-replay-cursor-workspace";
    const messageId = "nested-replay-cursor-message";
    const timestamp = Date.now();
    const streamInfo = createStreamInfoForTests({
      messageId,
      lastPartialWriteTime: timestamp,
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "code-exec-cursor",
          toolName: "code_execution",
          input: { code: "mux.workflow_run({...})" },
          state: "input-available",
          // Parent part predates the reconnect cursor...
          timestamp,
          nestedCalls: [
            {
              toolCallId: "nested-cursor-workflow",
              toolName: "workflow_run",
              input: {},
              state: "input-available",
              // ...but the nested workflow started after it.
              timestamp: timestamp + 100,
            },
          ],
        },
      ],
    });
    engineInternals(streamManager).workspaceStreams.set(workspaceId, streamInfo);

    const starts: ToolCallStartEvent[] = [];
    onTurnEngineEvent(streamManager, "tool-call-start", (event) => starts.push(event));

    await streamManager.replayStream(workspaceId, { afterTimestamp: timestamp + 50 });

    expect(starts.some((e) => e.toolCallId === "nested-cursor-workflow")).toBe(true);
  });
});

describe("StreamManager - nested tool call normalization", () => {
  test("normalizes zero-arg nested calls to {} for the persisted record and the wire event", () => {
    const streamManager = new StreamManager(historyService);
    const workspaceId = "nested-normalize-workspace";
    const messageId = "nested-normalize-message";
    const timestamp = Date.now();
    const parts: CompletedMessagePart[] = [
      {
        type: "dynamic-tool",
        toolCallId: "parent-1",
        toolName: "code_execution",
        input: { code: "mux.linear_list_teams()" },
        state: "input-available",
        timestamp,
      },
    ];
    const streamInfo = createStreamInfoForTests({ messageId, parts });
    engineInternals(streamManager).workspaceStreams.set(workspaceId, streamInfo);

    const events: unknown[] = [];
    onTurnEngineEvent(streamManager, "tool-call-start", (event: unknown) => events.push(event));

    streamManager.emitNestedToolEvent(
      { workspaceId, messageId, token: "test" },
      {
        type: "tool-call-start",
        callId: "nested-1",
        toolName: "linear_list_teams",
        // Zero-argument guest call: JSON cannot represent undefined, so both the
        // persisted record and the wire event must carry {} instead.
        args: undefined,
        parentToolCallId: "parent-1",
        startTime: timestamp,
      }
    );

    const parentPart = parts[0] as { nestedCalls?: Array<{ input?: unknown }> };
    expect(parentPart.nestedCalls).toHaveLength(1);
    expect(parentPart.nestedCalls?.[0]?.input).toEqual({});

    // The live event must survive oRPC output validation (args key required).
    expect(events).toHaveLength(1);
    expect(ToolCallStartEventSchema.safeParse(events[0]).success).toBe(true);
    expect((events[0] as { args?: unknown }).args).toEqual({});
  });
});

describe("StreamManager - tool execution start timing", () => {
  test("stamps executionStartedAt and emits tool-call-execution-start when the part already exists", () => {
    const streamManager = new StreamManager(historyService);
    const workspaceId = "execution-start-workspace";
    const messageId = "execution-start-message";
    // Seed the monotonic stream clock ahead of wall time: a raw Date.now() execution
    // start would be <= the tool-call timestamp and reconnect replay's
    // `executionStartedAt > cursor` repair predicate would never fire.
    const timestamp = Date.now() + 60_000;
    const streamInfo = createStreamInfoForTests({
      messageId,
      lastPartTimestamp: timestamp,
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "tool-call-1",
          toolName: "bash",
          input: { command: "echo hi" },
          state: "input-available",
          timestamp,
        },
      ],
    });
    engineInternals(streamManager).workspaceStreams.set(workspaceId, streamInfo);

    const events: ToolCallExecutionStartEvent[] = [];
    onTurnEngineEvent(
      streamManager,
      "tool-call-execution-start",
      (event: ToolCallExecutionStartEvent) => {
        events.push(event);
      }
    );

    const handleToolExecutionStart = engineInternals(streamManager).handleToolExecutionStart;
    handleToolExecutionStart.call(streamManager, workspaceId, messageId, "tool-call-1");

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "tool-call-execution-start",
      workspaceId,
      messageId,
      toolCallId: "tool-call-1",
    });
    // Cursor-monotonic: strictly after the tool-call part timestamp even when the wall
    // clock has not advanced past it.
    expect(events[0].timestamp).toBeGreaterThan(timestamp);

    const parts = streamInfo.parts as Array<Record<string, unknown>>;
    expect(parts[0].executionStartedAt).toBe(events[0].timestamp);
  });

  test("applies execution starts that arrive before the tool part lands", async () => {
    const streamManager = new StreamManager(historyService);
    const workspaceId = "execution-start-race-workspace";
    const messageId = "execution-start-race-message";
    const streamInfo = createStreamInfoForTests({ messageId, parts: [] });
    engineInternals(streamManager).workspaceStreams.set(workspaceId, streamInfo);

    const events: ToolCallExecutionStartEvent[] = [];
    onTurnEngineEvent(
      streamManager,
      "tool-call-execution-start",
      (event: ToolCallExecutionStartEvent) => {
        events.push(event);
      }
    );

    // execute() wins the race: no part yet, so the start is parked as pending.
    const handleToolExecutionStart = engineInternals(streamManager).handleToolExecutionStart;
    handleToolExecutionStart.call(streamManager, workspaceId, messageId, "tool-call-race");
    expect(events).toHaveLength(0);

    const appendPartAndEmit = engineInternals(streamManager).appendPartAndEmit;
    await appendPartAndEmit.call(
      streamManager,
      workspaceId,
      streamInfo,
      {
        type: "dynamic-tool",
        toolCallId: "tool-call-race",
        toolName: "bash",
        input: { command: "echo hi" },
        state: "input-available",
        timestamp: Date.now(),
      },
      false
    );

    expect(events).toHaveLength(1);
    expect(events[0].toolCallId).toBe("tool-call-race");

    const parts = streamInfo.parts as Array<Record<string, unknown>>;
    expect(parts[0].executionStartedAt).toBe(events[0].timestamp);
    expect((streamInfo.pendingToolExecutionStarts as Map<string, number>).size).toBe(0);
  });
});
