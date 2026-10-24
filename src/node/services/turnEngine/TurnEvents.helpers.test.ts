import { describe, expect, spyOn, test } from "bun:test";

import type { NestedToolCall } from "@/common/orpc/schemas/message";
import type { MCPToolCallDisplay } from "@/common/types/mcp";
import type { CompletedMessagePart } from "@/common/types/stream";
import { log } from "@/node/services/log";

import type { WorkspaceId } from "@/node/services/streamManager";

import { applyNestedToolEvent, buildStreamStartEvent, shouldReplayPartAfter } from "./TurnEvents";

const WORKSPACE_ID = "event-helpers-ws" as WorkspaceId;

describe("buildStreamStartEvent", () => {
  const stream = {
    messageId: "msg-1",
    model: "anthropic:claude-sonnet-4-5",
    metadataModel: "anthropic:claude-sonnet-4-5",
    startTime: 100,
  };

  test("a bare stream carries only the required fields", () => {
    expect(buildStreamStartEvent(WORKSPACE_ID, stream, 3, undefined)).toStrictEqual({
      type: "stream-start",
      workspaceId: WORKSPACE_ID,
      messageId: "msg-1",
      model: "anthropic:claude-sonnet-4-5",
      metadataModel: "anthropic:claude-sonnet-4-5",
      historySequence: 3,
      startTime: 100,
    });
  });

  test("carries the replay flag, thinking level and turn metadata when present", () => {
    const event = buildStreamStartEvent(
      WORKSPACE_ID,
      {
        ...stream,
        thinkingLevel: "high",
        initialMetadata: {
          agentId: "exec",
          mode: "plan",
          routeProvider: "openrouter",
          acpPromptId: "acp-1",
          muxMetadata: { type: "normal" },
        },
      },
      3,
      true
    );
    expect(event).toMatchObject({
      replay: true,
      thinkingLevel: "high",
      agentId: "exec",
      mode: "plan",
      routeProvider: "openrouter",
      acpPromptId: "acp-1",
      muxMetadata: { type: "normal" },
    });
  });

  test("drops a mode the stats schema does not accept", () => {
    const event = buildStreamStartEvent(
      WORKSPACE_ID,
      { ...stream, initialMetadata: { mode: "compact" } },
      3,
      false
    );
    expect(event).not.toHaveProperty("mode");
    expect(event).not.toHaveProperty("replay");
  });
});

type ToolPart = Extract<CompletedMessagePart, { type: "dynamic-tool" }>;
interface ToolPartExtras {
  timestamp?: number;
  executionStartedAt?: number;
  workflowRun?: ToolPart["workflowRun"];
  nestedCalls?: NestedToolCall[];
}

function toolPart(extras: ToolPartExtras = {}): ToolPart {
  const base = { type: "dynamic-tool", toolCallId: "call-1", toolName: "bash", input: {} } as const;
  return { ...base, state: "input-available", timestamp: 10, ...extras };
}

function completedToolPart(extras: ToolPartExtras = {}): ToolPart {
  const base = { type: "dynamic-tool", toolCallId: "call-1", toolName: "bash", input: {} } as const;
  return { ...base, state: "output-available", output: {}, timestamp: 10, ...extras };
}

describe("shouldReplayPartAfter", () => {
  const CURSOR = 50;
  const replays = (part: CompletedMessagePart, completions: Array<[string, number]> = []) =>
    shouldReplayPartAfter(
      part,
      CURSOR,
      { messageId: "msg-1", toolCompletionTimestamps: new Map(completions) },
      WORKSPACE_ID
    );
  const nested = (overrides: Partial<NestedToolCall>): NestedToolCall => ({
    toolCallId: "nested-1",
    toolName: "bash",
    state: "input-available",
    timestamp: 10,
    ...overrides,
  });

  test("replays parts after the cursor and parts without a timestamp", () => {
    expect(replays({ type: "text", text: "a", timestamp: 51 })).toBe(true);
    expect(replays({ type: "text", text: "a" })).toBe(true);
    expect(replays({ type: "text", text: "a", timestamp: 50 })).toBe(false);
    expect(replays(toolPart({ timestamp: 50 }))).toBe(false);
  });

  test("replays an older tool part whose attachment or execute start is newer", () => {
    expect(replays(toolPart({ workflowRun: { runId: "wfr_1", timestamp: 51 } }))).toBe(true);
    expect(replays(toolPart({ workflowRun: { runId: "wfr_1", timestamp: 50 } }))).toBe(false);
    expect(replays(toolPart({ executionStartedAt: 51 }))).toBe(true);
    expect(replays(toolPart({ executionStartedAt: 50 }))).toBe(false);
  });

  test("an output-available tool part replays by its completion time", () => {
    const done = completedToolPart({ executionStartedAt: 60 });
    expect(replays(done, [["call-1", 51]])).toBe(true);
    // The completion decides, even though execute() started after the cursor.
    expect(replays(done, [["call-1", 50]])).toBe(false);
  });

  test("drops an output-available tool part without a completion time, with a warning", () => {
    const warn = spyOn(log, "warn").mockImplementation(() => undefined);
    try {
      expect(replays(completedToolPart())).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  test.each<[string, NestedToolCall, Array<[string, number]>, boolean]>([
    ["started after the cursor", nested({ timestamp: 51 }), [], true],
    ["without a timestamp", nested({ timestamp: undefined }), [], true],
    [
      "attached after the cursor",
      nested({ workflowRun: { runId: "wfr_1", timestamp: 51 } }),
      [],
      true,
    ],
    [
      "attached before the cursor",
      nested({ workflowRun: { runId: "wfr_1", timestamp: 50 } }),
      [],
      false,
    ],
    ["completed after the cursor", nested({ state: "output-available" }), [["nested-1", 51]], true],
    [
      "completed before the cursor",
      nested({ state: "output-available" }),
      [["nested-1", 50]],
      false,
    ],
    ["completed without a completion time", nested({ state: "output-available" }), [], true],
    ["unchanged", nested({}), [], false],
  ])("replays the parent of a nested call %s: %#", (_label, call, completions, expected) => {
    expect(replays(toolPart({ nestedCalls: [call] }), completions)).toBe(expected);
  });
});

describe("applyNestedToolEvent", () => {
  const event = {
    callId: "nested-1",
    toolName: "bash",
    args: { raw: true },
    parentToolCallId: "parent",
    startTime: 10,
  };
  const mcpServer: MCPToolCallDisplay = {
    connection: { key: "srv", transport: "stdio" },
    identity: { name: "srv", version: "1.0.0" },
    source: "connection",
  };

  test("a start adds an input-available record with the normalized args", () => {
    const calls: NestedToolCall[] = [];
    applyNestedToolEvent(calls, { ...event, type: "tool-call-start" }, {}, undefined);
    expect(calls).toStrictEqual([
      {
        toolCallId: "nested-1",
        toolName: "bash",
        input: {},
        state: "input-available",
        timestamp: 10,
      },
    ]);
  });

  test("an end completes only the matching record, with its MCP server", () => {
    const other: NestedToolCall = {
      toolCallId: "other",
      toolName: "bash",
      state: "input-available",
    };
    const calls: NestedToolCall[] = [other];
    applyNestedToolEvent(calls, { ...event, type: "tool-call-start" }, {}, undefined);
    applyNestedToolEvent(
      calls,
      { ...event, type: "tool-call-end", result: { ok: 1 } },
      {},
      mcpServer
    );
    expect(calls[0]).toBe(other);
    expect(calls[1]).toMatchObject({ state: "output-available", output: { ok: 1 }, mcpServer });
  });

  test("an end without a result records the error, and an unknown end changes nothing", () => {
    const calls: NestedToolCall[] = [];
    applyNestedToolEvent(calls, { ...event, type: "tool-call-start" }, {}, undefined);
    applyNestedToolEvent(calls, { ...event, type: "tool-call-end", error: "boom" }, {}, undefined);
    expect(calls[0]).toMatchObject({ state: "output-available", output: { error: "boom" } });
    expect(calls[0]).not.toHaveProperty("mcpServer");
    applyNestedToolEvent(
      calls,
      { ...event, callId: "missing", type: "tool-call-end" },
      {},
      undefined
    );
    expect(calls).toHaveLength(1);
  });
});
