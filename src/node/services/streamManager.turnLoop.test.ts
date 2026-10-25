import { describe, expect, test } from "bun:test";

import type { StreamStopCause } from "@/common/types/streamStopCause";

import { createLiveStreamHarness } from "./streamManager.liveStream.testHarness";
import { installStreamManagerTestHistory } from "./streamManager.suite.testHarness";

import {
  applyContextBudgetDecision,
  hasSuccessfulRequiredToolResult,
  isSuccessfulToolOutput,
  type WorkspaceId,
} from "./streamManager";
import { buildStreamEndEvent, resolveStreamEndFinishReason } from "./turnEngine/AttemptLoop";

installStreamManagerTestHistory();

type StopOptions = Parameters<typeof hasSuccessfulRequiredToolResult>[0];

/** Stop-condition options whose last step returned these tool results. */
function lastStepResults(
  ...toolResults: Array<{ toolName: string; output: unknown }>
): StopOptions {
  // The helpers read only steps[].toolResults; a full SDK StepResult is not needed.
  const options = { steps: [{ toolResults: [] }, { toolResults }] };
  return options as unknown as StopOptions;
}

describe("isSuccessfulToolOutput", () => {
  test.each<[string, unknown, boolean]>([
    ["a non-object", "done", false],
    ["null", null, false],
    ["an explicit success marker", { success: true }, true],
    ["a failed success marker, even with ok", { success: false, ok: true }, false],
    ["a success marker that is not true", { success: "yes" }, false],
    ["an ok marker", { ok: true }, true],
    ["a failed ok marker", { ok: false }, false],
    ["an error field", { error: "boom" }, false],
    ["an isError flag", { isError: true }, false],
    ["any other object", { value: 1 }, true],
  ])("%s", (_label, output, expected) => {
    expect(isSuccessfulToolOutput(output)).toBe(expected);
  });
});

describe("hasSuccessfulRequiredToolResult", () => {
  const required = [/^agent_report$/];

  test("matches a successful required tool in the last step only", () => {
    expect(
      hasSuccessfulRequiredToolResult(
        lastStepResults({ toolName: "agent_report", output: { success: true } }),
        required
      )
    ).toBe(true);
    expect(
      hasSuccessfulRequiredToolResult(
        lastStepResults({ toolName: "agent_report", output: { success: false } }),
        required
      )
    ).toBe(false);
    expect(
      hasSuccessfulRequiredToolResult(
        lastStepResults({ toolName: "bash", output: { success: true } }),
        required
      )
    ).toBe(false);
  });

  test("never counts new_context, and needs a policy", () => {
    const newContext = lastStepResults({ toolName: "new_context", output: { success: true } });
    expect(hasSuccessfulRequiredToolResult(newContext, [/.*/])).toBe(false);
    const report = lastStepResults({ toolName: "agent_report", output: { success: true } });
    expect(hasSuccessfulRequiredToolResult(report, [])).toBe(false);
    const empty: StopOptions = { steps: [] };
    expect(hasSuccessfulRequiredToolResult(empty, required)).toBe(false);
  });
});

describe("applyContextBudgetDecision", () => {
  test("continue records nothing and keeps going", () => {
    const request: { stopCause?: StreamStopCause } = {};
    expect(applyContextBudgetDecision(request, { decision: "continue" })).toBe(false);
    expect(request.stopCause).toBeUndefined();
  });

  test("a rollover stops and names its successor; an earlier stop cause wins", () => {
    const request: { stopCause?: StreamStopCause } = {};
    expect(
      applyContextBudgetDecision(request, { decision: "rollover", continuationEntryId: "q-1" })
    ).toBe(true);
    expect(request.stopCause).toEqual({
      kind: "context-budget",
      decision: "rollover",
      continuationEntryId: "q-1",
    });
    const earlier: { stopCause?: StreamStopCause } = { stopCause: { kind: "step-limit" } };
    expect(applyContextBudgetDecision(earlier, { decision: "warn" })).toBe(true);
    expect(earlier.stopCause).toEqual({ kind: "step-limit" });
  });

  test("a block records no successor and throws", () => {
    const request: { stopCause?: StreamStopCause } = {};
    expect(() =>
      applyContextBudgetDecision(request, { decision: "block", continuationEntryId: "q-1" })
    ).toThrow("exceed the context budget");
    expect(request.stopCause).toEqual({ kind: "context-budget", decision: "block" });
  });
});

describe("resolveStreamEndFinishReason", () => {
  test("a required-tool stop persists as stop; else the terminal reason wins over the provider", () => {
    const requiredTool = { request: { stopCause: { kind: "required-tool" } as const } };
    expect(resolveStreamEndFinishReason(requiredTool, "tool-calls")).toBe("stop");
    expect(
      resolveStreamEndFinishReason({ request: {}, terminalFinishReason: "length" }, "stop")
    ).toBe("length");
    expect(resolveStreamEndFinishReason({ request: {} }, "tool-calls")).toBe("tool-calls");
  });
});

describe("buildStreamEndEvent", () => {
  const usage = { inputTokens: 10, outputTokens: 2, totalTokens: 12 };
  const stream = {
    messageId: "msg-1",
    model: "anthropic:claude-sonnet-4-5",
    metadataModel: "anthropic:claude-sonnet-4-5",
    toolModelUsages: [],
    request: {},
    historySequence: 4,
    parts: [],
  };
  const end = {
    totalUsage: usage,
    contextUsage: usage,
    providerMetadata: undefined,
    contextProviderMetadata: undefined,
    finishReason: undefined,
    duration: 30,
    ttftMs: undefined,
  };

  test("a bare stream omits the optional metadata", () => {
    const event = buildStreamEndEvent("ws-1" as WorkspaceId, stream, end);
    expect(event).not.toHaveProperty("acpPromptId");
    for (const key of ["thinkingLevel", "toolModelUsages", "finishReason", "stopCause", "ttftMs"]) {
      expect(event.metadata).not.toHaveProperty(key);
    }
    expect(event.metadata).toMatchObject({ historySequence: 4, duration: 30, usage });
  });

  test("carries the turn metadata, stop cause and copies of the tool-model usages", () => {
    const toolUsage = { toolName: "advisor", model: "openai:gpt-5", usage };
    const event = buildStreamEndEvent(
      "ws-1" as WorkspaceId,
      {
        ...stream,
        thinkingLevel: "high",
        initialMetadata: { acpPromptId: "acp-1", agentId: "exec" },
        toolModelUsages: [toolUsage],
        request: { stopCause: { kind: "required-tool" } },
      },
      { ...end, finishReason: "stop", ttftMs: 7 }
    );
    expect(event.acpPromptId).toBe("acp-1");
    expect(event.metadata).toMatchObject({
      agentId: "exec",
      thinkingLevel: "high",
      finishReason: "stop",
      stopCause: { kind: "required-tool" },
      ttftMs: 7,
      toolModelUsages: [toolUsage],
    });
    // A copy: later in-place usage changes must not reach the emitted event.
    expect(event.metadata.toolModelUsages?.[0]).not.toBe(toolUsage);
  });
});

describe("StreamManager stream completion", () => {
  test("a completed stream stops counting as streaming before its stream-end is emitted", async () => {
    // The stream is marked completed after its final commit and right before stream-end,
    // so stream-end listeners (compaction among them) no longer see it as streaming.
    const harness = createLiveStreamHarness();
    const workspaceId = "ws-complete-order";
    const streamingAtEnd: boolean[] = [];
    harness.streamManager.setEventSink((event) => {
      if (event.type === "stream-end") {
        streamingAtEnd.push(harness.streamManager.isStreaming(workspaceId));
      }
      harness.events.push(event);
    });
    const live = await harness.start({ workspaceId, messageId: "msg-1" });
    await live.push({ type: "text-delta", text: "done" });
    await live.finish();
    expect(streamingAtEnd).toEqual([false]);
  });
});
