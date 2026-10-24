import { describe, expect, spyOn, test } from "bun:test";

import type { NestedToolCall } from "@/common/orpc/schemas/message";
import type { CompletedMessagePart, WorkflowRunAttachedEvent } from "@/common/types/stream";
import type { WorkflowRunRecord } from "@/common/types/workflow";
import { log } from "@/node/services/log";
import type { TurnEngineEvent, WorkspaceId } from "@/node/services/turnEngine/types";

import { TurnEvents, type TurnEventsStream } from "./TurnEvents";

const WORKSPACE_ID = "turn-events-ws" as WorkspaceId;
const MESSAGE_ID = "msg-1";

/** A TurnEvents with a collecting sink, and the partial flushes it asked for. */
function createTurnEvents() {
  const events: TurnEngineEvent[] = [];
  const flushes: CompletedMessagePart[][] = [];
  const turnEvents = new TurnEvents<TurnEventsStream>((event) => void events.push(event), {
    // Snapshot what the flush would persist, to check the attachment landed first.
    flushPartialWrite: (_workspaceId, streamInfo) => {
      flushes.push(structuredClone(streamInfo.parts));
      return Promise.resolve();
    },
  });
  return { turnEvents, events, flushes };
}

function streamFixture(parts: CompletedMessagePart[] = []): TurnEventsStream {
  return {
    messageId: MESSAGE_ID,
    parts,
    pendingWorkflowRunAttachments: new Map(),
    pendingNestedCalls: new Map(),
  };
}

function toolPart(toolCallId: string, nestedCalls?: NestedToolCall[]): CompletedMessagePart {
  return {
    type: "dynamic-tool",
    toolCallId,
    toolName: "code_execution",
    input: {},
    state: "input-available",
    timestamp: 1,
    ...(nestedCalls != null ? { nestedCalls } : {}),
  };
}

const run: WorkflowRunRecord = {
  id: "wfr_1",
  workspaceId: WORKSPACE_ID,
  workflow: { name: "deep-research", description: "test", scope: "project", executable: true },
  source: "export default function workflow() {}",
  sourceHash: "sha256:test",
  args: {},
  status: "running",
  createdAt: "2026-05-29T00:00:00.000Z",
  updatedAt: "2026-05-29T00:00:01.000Z",
  events: [],
  steps: [],
};

function attachedEvent(
  toolCallId: string,
  overrides: Partial<WorkflowRunAttachedEvent> = {}
): WorkflowRunAttachedEvent {
  return {
    type: "workflow-run-attached",
    workspaceId: WORKSPACE_ID,
    messageId: MESSAGE_ID,
    toolCallId,
    runId: "wfr_1",
    run,
    timestamp: 50,
    ...overrides,
  };
}

describe("TurnEvents delivery", () => {
  test("delivers events in order to the current sink", () => {
    const { turnEvents, events } = createTurnEvents();
    turnEvents.emitTurnEvent({
      type: "stream-delta",
      workspaceId: WORKSPACE_ID,
      messageId: MESSAGE_ID,
      delta: "a",
      tokens: 1,
      timestamp: 1,
    });
    const replaced: TurnEngineEvent[] = [];
    turnEvents.setEventSink((event) => void replaced.push(event));
    turnEvents.emitTurnEvent({
      type: "stream-delta",
      workspaceId: WORKSPACE_ID,
      messageId: MESSAGE_ID,
      delta: "b",
      tokens: 1,
      timestamp: 2,
    });
    expect(events.map((event) => event.type === "stream-delta" && event.delta)).toEqual(["a"]);
    expect(replaced.map((event) => event.type === "stream-delta" && event.delta)).toEqual(["b"]);
  });

  test("logs a failing async sink on the fire-and-forget path, and awaits abort delivery", async () => {
    const errorSpy = spyOn(log, "error").mockImplementation(() => undefined);
    try {
      const turnEvents = new TurnEvents<TurnEventsStream>(
        () => Promise.reject(new Error("sink boom")),
        { flushPartialWrite: () => Promise.resolve() }
      );
      turnEvents.emitTurnEvent({
        type: "stream-delta",
        workspaceId: WORKSPACE_ID,
        messageId: MESSAGE_ID,
        delta: "a",
        tokens: 1,
        timestamp: 1,
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(errorSpy).toHaveBeenCalledWith("Turn event sink failed", {
        eventType: "stream-delta",
        error: "sink boom",
      });
      // Abort delivery is sequenced by its caller, so its rejection reaches the caller.
      const outcome = await turnEvents.emitStreamAbort(WORKSPACE_ID, MESSAGE_ID, {}, "user").then(
        () => null,
        (error: unknown) => error
      );
      expect(outcome).toBeInstanceOf(Error);
      expect(outcome).toHaveProperty("message", "sink boom");
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("abort delivery resolves only after the sink settles", async () => {
    let release: () => void = () => undefined;
    const delivered: TurnEngineEvent[] = [];
    const turnEvents = new TurnEvents<TurnEventsStream>(
      (event) =>
        new Promise<void>((resolve) => {
          delivered.push(event);
          release = resolve;
        }),
      { flushPartialWrite: () => Promise.resolve() }
    );
    let settled = false;
    const abort = turnEvents
      .emitStreamAbort(WORKSPACE_ID, MESSAGE_ID, { duration: 5 }, "user", true, "acp-1")
      .then(() => {
        settled = true;
      });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(delivered).toEqual([
      {
        type: "stream-abort",
        workspaceId: WORKSPACE_ID,
        messageId: MESSAGE_ID,
        abortReason: "user",
        metadata: { duration: 5 },
        abandonPartial: true,
        acpPromptId: "acp-1",
      },
    ]);
    release();
    await abort;
    expect(settled).toBe(true);
  });
});

describe("TurnEvents emitNestedCallEvents", () => {
  test("emits start, attachment and end per nested call under its parent", () => {
    const { turnEvents, events } = createTurnEvents();
    const nested: NestedToolCall[] = [
      {
        toolCallId: "n1",
        toolName: "workflow_run",
        input: { name: "x" },
        output: { ok: true },
        state: "output-available",
        timestamp: 10,
        workflowRun: { runId: "wfr_1", timestamp: 11 },
      },
      // Zero-argument call without a timestamp: args default to {} and the parent's time.
      { toolCallId: "n2", toolName: "bash", state: "input-available" },
    ];
    turnEvents.emitNestedCallEvents(WORKSPACE_ID, MESSAGE_ID, "parent", nested, {
      replay: true,
      fallbackTimestamp: 7,
    });
    expect(
      events.map((event) => [
        event.type,
        "toolCallId" in event ? event.toolCallId : null,
        "parentToolCallId" in event ? event.parentToolCallId : null,
        "replay" in event ? event.replay : null,
      ])
    ).toEqual([
      ["tool-call-start", "n1", "parent", true],
      ["workflow-run-attached", "n1", null, true],
      ["tool-call-end", "n1", "parent", true],
      ["tool-call-start", "n2", "parent", true],
    ]);
    expect(events[0]).toMatchObject({ args: { name: "x" }, timestamp: 10, tokens: 0 });
    expect(events[1]).toMatchObject({ runId: "wfr_1", timestamp: 11 });
    expect(events[2]).toMatchObject({ result: { ok: true } });
    expect(events[3]).toMatchObject({ args: {}, timestamp: 7 });
  });

  test("live re-delivery carries no replay flag", () => {
    const { turnEvents, events } = createTurnEvents();
    turnEvents.emitNestedCallEvents(
      WORKSPACE_ID,
      MESSAGE_ID,
      "parent",
      [{ toolCallId: "n1", toolName: "bash", input: {}, state: "input-available", timestamp: 3 }],
      { fallbackTimestamp: 7 }
    );
    expect(events).toHaveLength(1);
    expect("replay" in events[0]).toBe(false);
  });
});

describe("TurnEvents workflow-run attachments", () => {
  test("refuses an attachment without a matching stream", async () => {
    const { turnEvents, flushes } = createTurnEvents();
    expect(await turnEvents.attachWorkflowRunToToolCall(attachedEvent("call-1"), undefined)).toBe(
      false
    );
    const stream = streamFixture([toolPart("call-1")]);
    const otherTurn = attachedEvent("call-1", { messageId: "msg-other" });
    expect(await turnEvents.attachWorkflowRunToToolCall(otherTurn, stream)).toBe(false);
    expect(stream.parts[0]).not.toHaveProperty("workflowRun");
    expect(flushes).toEqual([]);
  });

  test("attaches to the tool part, then flushes the partial with it", async () => {
    const { turnEvents, flushes } = createTurnEvents();
    const stream = streamFixture([toolPart("call-1")]);
    // A stale buffered attachment for the same call must not apply later.
    stream.pendingWorkflowRunAttachments.set("call-1", { runId: "wfr_old", timestamp: 1 });
    expect(await turnEvents.attachWorkflowRunToToolCall(attachedEvent("call-1"), stream)).toBe(
      true
    );
    const attachment = { runId: "wfr_1", run, timestamp: 50 };
    expect(stream.parts[0]).toMatchObject({ workflowRun: attachment });
    expect(flushes).toHaveLength(1);
    expect(flushes[0][0]).toMatchObject({ workflowRun: attachment });
    expect(turnEvents.takePendingWorkflowRunAttachment(stream, "call-1")).toBeUndefined();
  });

  test("attaches only the run identity to a nested call, on a part or still buffered", async () => {
    const { turnEvents, flushes } = createTurnEvents();
    const nested = (toolCallId: string): NestedToolCall => ({
      toolCallId,
      toolName: "workflow_run",
      state: "input-available",
      timestamp: 2,
    });
    const stream = streamFixture([toolPart("code-1", [nested("n-on-part")])]);
    stream.pendingNestedCalls.set("code-2", [nested("n-buffered")]);

    expect(await turnEvents.attachWorkflowRunToToolCall(attachedEvent("n-on-part"), stream)).toBe(
      true
    );
    expect(flushes).toHaveLength(1);
    expect(await turnEvents.attachWorkflowRunToToolCall(attachedEvent("n-buffered"), stream)).toBe(
      true
    );
    // The buffered record persists with its parent part later; no flush now.
    expect(flushes).toHaveLength(1);

    const identity = { runId: "wfr_1", timestamp: 50 };
    const part = stream.parts[0];
    expect(part.type === "dynamic-tool" && part.nestedCalls?.[0]?.workflowRun).toEqual(identity);
    expect(stream.pendingNestedCalls.get("code-2")?.[0]?.workflowRun).toEqual(identity);
    expect(stream.pendingWorkflowRunAttachments.size).toBe(0);
  });

  test("buffers an attachment that races its part, and hands it out once", async () => {
    const { turnEvents, events, flushes } = createTurnEvents();
    const stream = streamFixture();
    const event = attachedEvent("call-late", { run: undefined });
    expect(await turnEvents.attachWorkflowRunToToolCall(event, stream)).toBe(true);
    expect(flushes).toEqual([]);
    const attachment = turnEvents.takePendingWorkflowRunAttachment(stream, "call-late");
    expect(attachment).toEqual({ runId: "wfr_1", timestamp: 50 });
    expect(turnEvents.takePendingWorkflowRunAttachment(stream, "call-late")).toBeUndefined();

    if (attachment == null) throw new Error("expected a buffered attachment");
    turnEvents.emitWorkflowRunAttachedFromAttachment({
      workspaceId: WORKSPACE_ID,
      messageId: MESSAGE_ID,
      toolCallId: "call-late",
      attachment,
    });
    // Without a run snapshot the event carries no run key.
    expect(events).toStrictEqual([
      {
        type: "workflow-run-attached",
        workspaceId: WORKSPACE_ID,
        messageId: MESSAGE_ID,
        toolCallId: "call-late",
        runId: "wfr_1",
        timestamp: 50,
      },
    ]);
  });
});
