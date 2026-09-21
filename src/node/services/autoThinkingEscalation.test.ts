import { describe, expect, it } from "bun:test";
import type { ModelMessage } from "ai";
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
    output: typeof failed | typeof errored | typeof succeeded;
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

  it("fires when one identical call is replayed in each step, regardless of key order or outcome", () => {
    const replayed = collectTurnToolSteps([
      { role: "user", content: "go" },
      ...toolStep([{ toolName: "grep", input: { pattern: "x", path: "src" }, output: succeeded }]),
      ...toolStep([
        { toolName: "file_read", input: { path: "other" }, output: succeeded },
        { toolName: "grep", input: { path: "src", pattern: "x" }, output: succeeded },
      ]),
      ...toolStep([{ toolName: "grep", input: { pattern: "x", path: "src" }, output: failed }]),
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
});

describe("proposeAutoThinkingEscalation", () => {
  it("raises one level per stuck window, judges each step once, and stops at the per-turn cap", () => {
    const persisted: AutoModelRoutingEscalation[][] = [];
    const state = createAutoThinkingEscalationState("low", (escalations) =>
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

  it("marks itself exhausted at the top of the ladder instead of proposing", () => {
    const state = createAutoThinkingEscalationState("max", () => undefined);
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
