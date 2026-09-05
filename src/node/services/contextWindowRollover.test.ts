import { describe, expect, test } from "bun:test";
import { createMuxMessage } from "@/common/types/message";
import {
  createContextBudgetWarning,
  createRolloverPrefix,
  currentContextWindowId,
  estimateLastStepToolResults,
  hasRolloverEligibleMessages,
  type ContextWindowRollover,
} from "./contextWindowRollover";

const rollover: ContextWindowRollover = {
  type: "context-window-rollover",
  rolloverId: "rollover-1",
  reason: "mid-stream",
  previousWindowId: "w:0",
  flushOpportunity: false,
  contextTokens: 90_000,
  maxTokens: 128_000,
};

describe("context window rollover recovery", () => {
  test("internal rows alone cannot make an already-reset window eligible for another rollover", () => {
    const old = createMuxMessage("old", "user", "Previous window work");
    const [boundary, leadIn] = createRolloverPrefix(rollover);
    expect(hasRolloverEligibleMessages([old])).toBe(true);
    expect(hasRolloverEligibleMessages([old, boundary])).toBe(false);
    expect(hasRolloverEligibleMessages([old, boundary, leadIn])).toBe(false);
    const warning = createContextBudgetWarning(80_000, 128_000, true);
    expect(hasRolloverEligibleMessages([old, boundary, leadIn, warning])).toBe(false);
    expect(
      hasRolloverEligibleMessages([
        old,
        boundary,
        leadIn,
        createMuxMessage("new", "user", "New window work"),
      ])
    ).toBe(true);
  });

  test("window identity follows the newest durable boundary rather than later warnings", () => {
    expect(currentContextWindowId([])).toBe("w:0");
    const [first] = createRolloverPrefix(rollover);
    const [second] = createRolloverPrefix({ ...rollover, rolloverId: "rollover-2" });
    first.metadata!.historySequence = 4;
    second.metadata!.historySequence = 12;
    expect(
      currentContextWindowId([first, second, createContextBudgetWarning(80_000, 128_000, true)])
    ).toBe("w:12");
    expect(currentContextWindowId([first])).not.toBe(currentContextWindowId([second]));
  });

  test("restart estimates only settled outputs from the final step, not prior steps or tool arguments", () => {
    const message = createMuxMessage("answer", "assistant", "", {
      stepStartPartIndices: [0, 2],
    });
    message.parts = [
      {
        type: "dynamic-tool",
        toolName: "bash",
        toolCallId: "old",
        state: "output-available",
        input: {},
        output: "x".repeat(300_000),
      },
      { type: "text", text: "completed prior step" },
      {
        type: "dynamic-tool",
        toolName: "bash",
        toolCallId: "last",
        state: "output-available",
        input: { script: "x".repeat(300_000) },
        output: "done",
      },
      {
        type: "dynamic-tool",
        toolName: "bash",
        toolCallId: "pending",
        state: "input-available",
        input: { script: "x".repeat(300_000) },
      },
    ];
    const finalStep = estimateLastStepToolResults(message);
    expect(finalStep.toolResultChars).toBeGreaterThan(0);
    expect(finalStep.toolResultChars).toBeLessThan(100);
    expect(finalStep.imageParts).toBe(0);
    message.metadata!.stepStartPartIndices = [0];
    expect(estimateLastStepToolResults(message).toolResultChars).toBeGreaterThan(300_000);
    expect(estimateLastStepToolResults(undefined)).toEqual({ toolResultChars: 0, imageParts: 0 });
  });
});
