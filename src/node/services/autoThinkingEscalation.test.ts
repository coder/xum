import { describe, expect, it } from "bun:test";
import type { ModelMessage, ToolResultPart } from "ai";
import {
  collectTurnToolSteps,
  createAutoThinkingEscalationState,
  detectStuckReason,
  proposeAutoThinkingEscalation,
  recordAutoThinkingEscalation,
} from "./autoThinkingEscalation";
import type { AutoModelRoutingEscalation } from "@/common/types/autoModelRouting";

const failed = { type: "json" as const, value: { success: false, error: "boom" } };
const errored = { type: "error-text" as const, value: "boom" };
const succeeded = { type: "json" as const, value: { success: true, output: "ok" } };

function toolStep(
  calls: Array<{
    toolName: string;
    input: unknown;
    output: ToolResultPart["output"];
  }>
): ModelMessage[] {
  return [
    {
      role: "assistant",
      content: calls.map((call, index) => ({
        type: "tool-call" as const,
        toolCallId: `call-${index}`,
        toolName: call.toolName,
        input: call.input,
      })),
    },
    {
      role: "tool",
      content: calls.map((call, index) => ({
        type: "tool-result" as const,
        toolCallId: `call-${index}`,
        toolName: call.toolName,
        output: call.output,
      })),
    },
  ];
}

const failingBash = (command: string) =>
  toolStep([{ toolName: "bash", input: { command }, output: failed }]);

describe("collectTurnToolSteps", () => {
  it("counts only tool steps after the last user message and skips text-only steps", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "first" },
      ...failingBash("old"),
      { role: "user", content: "second" },
      ...toolStep([{ toolName: "file_read", input: { path: "a" }, output: succeeded }]),
      { role: "assistant", content: [{ type: "text", text: "thinking aloud" }] },
      ...toolStep([
        { toolName: "bash", input: { command: "make" }, output: errored },
        { toolName: "file_read", input: { path: "b" }, output: failed },
      ]),
    ];
    const steps = collectTurnToolSteps(messages);
    expect(steps).toHaveLength(2);
    expect(steps[0].allFailed).toBe(false);
    expect(steps[1].allFailed).toBe(true);
    expect(steps[1].calls.map((call) => call.toolName)).toEqual(["bash", "file_read"]);
  });
});

describe("detectStuckReason", () => {
  it("fires after three consecutive steps whose calls all failed, in either failure shape", () => {
    const steps = collectTurnToolSteps([
      { role: "user", content: "go" },
      ...failingBash("a"),
      ...toolStep([{ toolName: "file_read", input: { path: "x" }, output: errored }]),
      ...failingBash("c"),
    ]);
    expect(detectStuckReason(steps)).toBeDefined();
  });

  it("stays quiet when one step in the window succeeded or the window is short", () => {
    const oneSuccess = collectTurnToolSteps([
      { role: "user", content: "go" },
      ...failingBash("a"),
      ...toolStep([{ toolName: "bash", input: { command: "b" }, output: succeeded }]),
      ...failingBash("c"),
    ]);
    expect(detectStuckReason(oneSuccess)).toBeUndefined();
    const short = collectTurnToolSteps([
      { role: "user", content: "go" },
      ...failingBash("a"),
      ...failingBash("b"),
    ]);
    expect(detectStuckReason(short)).toBeUndefined();
  });

  it("fires when one identical call keeps getting the identical result, regardless of key order", () => {
    const replayed = collectTurnToolSteps([
      { role: "user", content: "go" },
      ...toolStep([{ toolName: "grep", input: { pattern: "x", path: "src" }, output: succeeded }]),
      ...toolStep([
        { toolName: "file_read", input: { path: "other" }, output: succeeded },
        { toolName: "grep", input: { path: "src", pattern: "x" }, output: succeeded },
      ]),
      ...toolStep([{ toolName: "grep", input: { pattern: "x", path: "src" }, output: succeeded }]),
    ]);
    expect(detectStuckReason(replayed)).toContain("grep");
    const varied = collectTurnToolSteps([
      { role: "user", content: "go" },
      ...toolStep([{ toolName: "grep", input: { pattern: "x" }, output: succeeded }]),
      ...toolStep([{ toolName: "grep", input: { pattern: "y" }, output: succeeded }]),
      ...toolStep([{ toolName: "grep", input: { pattern: "x" }, output: succeeded }]),
    ]);
    expect(detectStuckReason(varied)).toBeUndefined();
  });

  it("does not treat a replay that makes progress, or a re-issued wait tool, as stuck", () => {
    const progress = (line: string) => ({ type: "json" as const, value: { success: true, line } });
    const polling = collectTurnToolSteps([
      { role: "user", content: "go" },
      ...toolStep([{ toolName: "bash", input: { command: "tail log" }, output: progress("a") }]),
      ...toolStep([{ toolName: "bash", input: { command: "tail log" }, output: progress("b") }]),
      ...toolStep([{ toolName: "bash", input: { command: "tail log" }, output: progress("c") }]),
    ]);
    expect(detectStuckReason(polling)).toBeUndefined();
    const waiting = collectTurnToolSteps([
      { role: "user", content: "go" },
      ...toolStep([{ toolName: "task_await", input: { task_ids: ["t1"] }, output: succeeded }]),
      ...toolStep([{ toolName: "task_await", input: { task_ids: ["t1"] }, output: succeeded }]),
      ...toolStep([{ toolName: "task_await", input: { task_ids: ["t1"] }, output: succeeded }]),
    ]);
    expect(detectStuckReason(waiting)).toBeUndefined();
  });
});

describe("proposeAutoThinkingEscalation", () => {
  it("raises one level per stuck window, judges each step once, and stops at the per-turn cap", () => {
    const persisted: AutoModelRoutingEscalation[][] = [];
    const state = createAutoThinkingEscalationState("low", [], (escalations) =>
      persisted.push(escalations)
    );
    const messages: ModelMessage[] = [{ role: "user", content: "go" }];
    const stuck = () =>
      messages.push(...failingBash("a"), ...failingBash("b"), ...failingBash("c"));

    stuck();
    const first = proposeAutoThinkingEscalation(state, messages);
    expect(first).toMatchObject({ from: "low", to: "medium", step: 4 });
    recordAutoThinkingEscalation(state, first!);
    expect(persisted.at(-1)).toHaveLength(1);
    // The same three steps must not fire again on the next prepareStep.
    expect(proposeAutoThinkingEscalation(state, messages)).toBeUndefined();

    stuck();
    const second = proposeAutoThinkingEscalation(state, messages);
    expect(second).toMatchObject({ from: "medium", to: "high", step: 7 });
    recordAutoThinkingEscalation(state, second!);
    expect(persisted.at(-1)?.map((escalation) => escalation.to)).toEqual(["medium", "high"]);

    stuck();
    expect(proposeAutoThinkingEscalation(state, messages)).toBeUndefined();
  });

  it("counts raises an earlier stream of the turn applied toward the cap", () => {
    const carried: AutoModelRoutingEscalation[] = [
      { step: 4, from: "low", to: "medium", reason: "r" },
      { step: 7, from: "medium", to: "high", reason: "r" },
    ];
    const state = createAutoThinkingEscalationState("high", carried, () => undefined);
    const messages: ModelMessage[] = [
      { role: "user", content: "go" },
      ...failingBash("a"),
      ...failingBash("b"),
      ...failingBash("c"),
    ];
    expect(proposeAutoThinkingEscalation(state, messages)).toBeUndefined();
  });

  it("does not let the steps that earned a carried raise earn the next one on a resume", () => {
    // The interrupted stream raised at step 4 over steps 1-3, which the resumed request
    // still carries in its transcript.
    const carried: AutoModelRoutingEscalation[] = [
      { step: 4, from: "low", to: "medium", reason: "r" },
    ];
    const state = createAutoThinkingEscalationState("medium", carried, () => undefined);
    const messages: ModelMessage[] = [
      { role: "user", content: "go" },
      ...failingBash("a"),
      ...failingBash("b"),
      ...failingBash("c"),
    ];
    expect(proposeAutoThinkingEscalation(state, messages)).toBeUndefined();

    // Three fresh failures after the resume qualify again.
    messages.push(...failingBash("d"), ...failingBash("e"), ...failingBash("f"));
    expect(proposeAutoThinkingEscalation(state, messages)).toMatchObject({
      from: "medium",
      to: "high",
      step: 7,
    });
  });

  it("starts counting fresh when a compaction follow-up carries a raise but none of its steps", () => {
    const carried: AutoModelRoutingEscalation[] = [
      { step: 4, from: "low", to: "medium", reason: "r" },
    ];
    const state = createAutoThinkingEscalationState("medium", carried, () => undefined);
    // Behind the new boundary the follow-up's first proposal sees no earlier tool steps.
    const messages: ModelMessage[] = [{ role: "user", content: "Continue" }];
    expect(proposeAutoThinkingEscalation(state, messages)).toBeUndefined();
    messages.push(...failingBash("a"), ...failingBash("b"), ...failingBash("c"));
    expect(proposeAutoThinkingEscalation(state, messages)).toMatchObject({
      from: "medium",
      to: "high",
      step: 4,
    });
  });

  it("marks itself exhausted at the top of the ladder instead of proposing", () => {
    const state = createAutoThinkingEscalationState("max", [], () => undefined);
    const messages: ModelMessage[] = [
      { role: "user", content: "go" },
      ...failingBash("a"),
      ...failingBash("b"),
      ...failingBash("c"),
    ];
    expect(proposeAutoThinkingEscalation(state, messages)).toBeUndefined();
    expect(state.exhausted).toBe(true);
  });
});
