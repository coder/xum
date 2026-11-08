import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test";

import { log } from "@/node/services/log";
import {
  createTestLanguageModel,
  createWorkspaceStreamInfoForTests,
} from "@/node/services/streamManager.suite.testHarness";

import { type FoldIntent, partFold } from "./partFold";
import {
  foldView,
  type PartLoopState,
  StepApply,
  type StepApplyDeps,
  summarizeToolResultForLog,
  turnReplayOffAfterServerTool,
} from "./StepApply";
import type { WorkspaceStreamInfo } from "./turnState";
import type { WorkspaceId } from "./types";

describe("summarizeToolResultForLog", () => {
  test("strings log their length and a preview cut at 160 characters", () => {
    expect(summarizeToolResultForLog("x".repeat(500))).toEqual({
      outputType: "string",
      outputLength: 500,
      outputPreview: "x".repeat(160),
    });
  });

  test("null, numbers and booleans log their type and value", () => {
    expect(summarizeToolResultForLog(null)).toEqual({ outputType: "null" });
    expect(summarizeToolResultForLog(42)).toEqual({ outputType: "number", outputPreview: "42" });
    expect(summarizeToolResultForLog(false)).toEqual({
      outputType: "boolean",
      outputPreview: "false",
    });
  });

  test("arrays log their length and the type of their first item", () => {
    expect(summarizeToolResultForLog([{ a: 1 }, "b"])).toEqual({
      outputType: "array",
      outputLength: 2,
      firstItemType: "object",
    });
    expect(summarizeToolResultForLog([null])).toEqual({
      outputType: "array",
      outputLength: 1,
      firstItemType: "null",
    });
    expect(summarizeToolResultForLog([])).toEqual({
      outputType: "array",
      outputLength: 0,
      firstItemType: undefined,
    });
  });

  test("objects log at most 8 keys, plus the format and value length of typed results", () => {
    const keys = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, i]));
    expect(summarizeToolResultForLog(keys)).toEqual({
      outputType: "object",
      outputKeyCount: 10,
      outputKeys: ["k0", "k1", "k2", "k3", "k4", "k5", "k6", "k7"],
    });
    expect(summarizeToolResultForLog({ type: "json", value: [1, 2, 3] })).toEqual({
      outputType: "object",
      outputKeyCount: 2,
      outputKeys: ["type", "value"],
      outputFormat: "json",
      outputValueLength: 3,
    });
    // A non-string type and a non-array value are not reported.
    expect(summarizeToolResultForLog({ type: 1, value: "v" })).toEqual({
      outputType: "object",
      outputKeyCount: 2,
      outputKeys: ["type", "value"],
    });
  });

  test("other values log their type", () => {
    expect(summarizeToolResultForLog(undefined)).toEqual({
      outputType: "undefined",
      outputPreview: undefined,
    });
  });
});

describe("turnReplayOffAfterServerTool", () => {
  const serverToolPart = {
    type: "dynamic-tool" as const,
    toolCallId: "srvtoolu_1",
    toolName: "web_search",
    state: "output-available" as const,
    input: { query: "xum" },
    output: [],
  };
  const anthropicStream = (parts: WorkspaceStreamInfo["parts"]) =>
    createWorkspaceStreamInfoForTests({
      parts,
      anthropicServerToolCallIds: new Set(["srvtoolu_1"]),
      request: {
        model: createTestLanguageModel("claude-opus-5-5", "anthropic.messages"),
        messages: [],
      },
    });

  test("reasoning after a server tool in the row turns thinking replay off up to the row end", () => {
    const streamInfo = anthropicStream([serverToolPart]);
    turnReplayOffAfterServerTool(streamInfo);
    expect(streamInfo.initialMetadata).toMatchObject({
      anthropicThinkingReplay: "off",
      anthropicThinkingReplayFromStep: "end",
    });
  });

  // A retry that discards the parts drops the server-tool part but not its recorded ID.
  // Dropping the stale IDs is the perf contract: later reasoning deltas return early
  // instead of scanning every part again.
  test("after a retry dropped the server-tool part, replay stays on and the stale IDs go", () => {
    const streamInfo = anthropicStream([]);
    turnReplayOffAfterServerTool(streamInfo);
    expect(streamInfo.initialMetadata?.anthropicThinkingReplay).toBeUndefined();
    expect(streamInfo.anthropicServerToolCallIds).toBeUndefined();
  });
});

describe("StepApply log intents", () => {
  const workspaceId = "ws-1" as WorkspaceId;
  const setup = () => {
    const streamInfo = createWorkspaceStreamInfoForTests();
    const loop: PartLoopState = {
      workspaceLog: log,
      toolCalls: new Map(),
      orphanToolResultCount: 0,
    };
    const apply = (intents: FoldIntent[]) =>
      new StepApply({} as StepApplyDeps).applyStep(
        workspaceId,
        streamInfo,
        { intents, lastPartTimestamp: 0 },
        loop
      );
    return { streamInfo, loop, apply };
  };

  let logError: Mock<typeof log.error>;
  let logWarn: Mock<typeof log.warn>;
  beforeEach(() => {
    logError = spyOn(log, "error").mockImplementation(() => undefined);
    logWarn = spyOn(log, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    logError.mockRestore();
    logWarn.mockRestore();
  });

  test("logs a rejected call's summary redacted while the tool output keeps it", async () => {
    const summary =
      "Invalid input for tool bash: script: Invalid input: expected string, received undefined. Received arguments: ghp_ABCdefSECRETxyz=string(16 chars)";
    const { streamInfo, loop, apply } = setup();
    const step = partFold(
      foldView(workspaceId, streamInfo, loop),
      { type: "tool-error", toolCallId: "call-1", toolName: "bash", error: summary },
      100
    );

    await apply(step.intents.filter((intent) => intent._tag === "LogToolError"));

    expect(logError.mock.calls).toEqual([
      [
        "Tool execution error for 'bash'",
        {
          toolCallId: "call-1",
          error:
            "Invalid input for tool bash: script: Invalid input: expected string, received undefined. Received arguments: [redacted]",
        },
      ],
    ]);
    expect(step.intents.find((intent) => intent._tag === "FinishToolCall")).toMatchObject({
      output: { success: false, error: summary },
    });
  });

  test("stops warning about orphan tool results after the third", async () => {
    const { loop, apply } = setup();
    const orphan: FoldIntent = {
      _tag: "LogOrphanToolResult",
      toolCallId: "call-1",
      toolName: "bash",
      output: "ok",
    };

    await apply([orphan, orphan, orphan, orphan, orphan]);

    expect(loop.orphanToolResultCount).toBe(5);
    expect(logWarn.mock.calls.map(([message]) => message)).toEqual([
      ...Array<string>(3).fill(
        "[streamManager] Received tool-result without matching tool-call map entry; persisting fallback output"
      ),
      "[streamManager] Suppressing additional orphan tool-result warnings for this stream",
    ]);
  });

  test("throws on an intent it has no handler for", async () => {
    const { apply } = setup();

    const outcome = await apply([{ _tag: "Unknown" } as unknown as FoldIntent]).then(
      () => "resolved",
      (error: unknown) => String(error)
    );

    expect(outcome).toContain("applyStep has no handler for Unknown");
  });
});
