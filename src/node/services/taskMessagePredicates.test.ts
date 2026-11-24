import { describe, expect, test } from "bun:test";

import { CONTEXT_BOUNDARY_KINDS } from "@/common/constants/contextBoundary";
import type { MuxMessage } from "@/common/types/message";
import {
  hasTerminalWorkflowTaskAwaitInParts,
  hasTerminalWorkflowToolOutputInParts,
  isCompactionRequestMessage,
  isWorkflowSupersessionMessage,
} from "@/node/services/taskMessagePredicates";

function message(fields: Record<string, unknown>): MuxMessage {
  return { id: "m", parts: [], ...fields } as unknown as MuxMessage;
}

function autoCompaction(dispatchSource: string | undefined): MuxMessage {
  return message({
    role: "user",
    metadata: {
      synthetic: true,
      muxMetadata: {
        type: "compaction-request",
        source: "auto-compaction",
        parsed: { followUpContent: { dispatchOptions: { source: dispatchSource } } },
      },
    },
  });
}

describe("isWorkflowSupersessionMessage", () => {
  test("a real user message, a reset boundary or a manual auto-compaction supersedes", () => {
    expect(isWorkflowSupersessionMessage(message({ role: "user" }))).toBe(true);
    expect(
      isWorkflowSupersessionMessage(
        message({
          role: "assistant",
          metadata: { contextBoundaryKind: CONTEXT_BOUNDARY_KINDS.RESET },
        })
      )
    ).toBe(true);
    expect(isWorkflowSupersessionMessage(autoCompaction(undefined))).toBe(true);
  });

  test("a synthetic message or an internal-resume compaction does not supersede", () => {
    expect(
      isWorkflowSupersessionMessage(message({ role: "user", metadata: { synthetic: true } }))
    ).toBe(false);
    expect(isWorkflowSupersessionMessage(autoCompaction("internal-resume"))).toBe(false);
    expect(isWorkflowSupersessionMessage(message({ role: "assistant" }))).toBe(false);
  });
});

describe("hasTerminalWorkflowTaskAwaitInParts", () => {
  const awaitPart = (result: unknown, state = "output-available") => ({
    type: "dynamic-tool",
    toolCallId: "c1",
    toolName: "task_await",
    state,
    input: {},
    output: { results: [result] },
  });

  test("completed, interrupted and failed-run errors are terminal for that run", () => {
    expect(
      hasTerminalWorkflowTaskAwaitInParts(
        [awaitPart({ taskId: "wfr_1", status: "completed" })],
        "wfr_1"
      )
    ).toBe(true);
    expect(
      hasTerminalWorkflowTaskAwaitInParts(
        [awaitPart({ taskId: "wfr_1", status: "interrupted" })],
        "wfr_1"
      )
    ).toBe(true);
    expect(
      hasTerminalWorkflowTaskAwaitInParts(
        [awaitPart({ taskId: "wfr_1", status: "error", run: { id: "wfr_1", status: "failed" } })],
        "wfr_1"
      )
    ).toBe(true);
  });

  test("a running run, another run, a plain error or an unfinished call is not terminal", () => {
    expect(
      hasTerminalWorkflowTaskAwaitInParts(
        [awaitPart({ taskId: "wfr_1", status: "running" })],
        "wfr_1"
      )
    ).toBe(false);
    expect(
      hasTerminalWorkflowTaskAwaitInParts(
        [awaitPart({ taskId: "wfr_2", status: "completed" })],
        "wfr_1"
      )
    ).toBe(false);
    expect(
      hasTerminalWorkflowTaskAwaitInParts(
        [awaitPart({ taskId: "wfr_1", status: "error" })],
        "wfr_1"
      )
    ).toBe(false);
    expect(
      hasTerminalWorkflowTaskAwaitInParts(
        [awaitPart({ taskId: "wfr_1", status: "completed" }, "input-available")],
        "wfr_1"
      )
    ).toBe(false);
  });
});

describe("isCompactionRequestMessage", () => {
  test("only a compaction-request row matches, and a row without metadata does not throw", () => {
    expect(
      isCompactionRequestMessage(
        message({ role: "user", metadata: { muxMetadata: { type: "compaction-request" } } })
      )
    ).toBe(true);
    expect(
      isCompactionRequestMessage(
        message({ role: "user", metadata: { muxMetadata: { type: "other" } } })
      )
    ).toBe(false);
    expect(isCompactionRequestMessage(message({ role: "user" }))).toBe(false);
  });
});

describe("hasTerminalWorkflowTaskAwaitInParts: malformed parts", () => {
  const part = (fields: Record<string, unknown>) => ({
    type: "dynamic-tool",
    toolCallId: "c1",
    toolName: "task_await",
    state: "output-available",
    input: {},
    ...fields,
  });
  const completed = { results: [{ taskId: "wfr_1", status: "completed" }] };

  test("skips other tools, other part types and malformed outputs", () => {
    expect(
      hasTerminalWorkflowTaskAwaitInParts([part({ toolName: "task", output: completed })], "wfr_1")
    ).toBe(false);
    expect(
      hasTerminalWorkflowTaskAwaitInParts([part({ type: "text", output: completed })], "wfr_1")
    ).toBe(false);
    expect(hasTerminalWorkflowTaskAwaitInParts([part({ output: null })], "wfr_1")).toBe(false);
    expect(hasTerminalWorkflowTaskAwaitInParts([part({ output: "done" })], "wfr_1")).toBe(false);
    expect(
      hasTerminalWorkflowTaskAwaitInParts([part({ output: { results: "done" } })], "wfr_1")
    ).toBe(false);
    expect(
      hasTerminalWorkflowTaskAwaitInParts([part({ output: { results: [null, 5] } })], "wfr_1")
    ).toBe(false);
  });

  test("an error result is terminal only with a failed snapshot of the same run", () => {
    const error = (run: unknown) => [
      part({ output: { results: [{ taskId: "wfr_1", status: "error", run }] } }),
    ];
    expect(hasTerminalWorkflowTaskAwaitInParts(error(null), "wfr_1")).toBe(false);
    expect(
      hasTerminalWorkflowTaskAwaitInParts(error({ id: "wfr_1", status: "running" }), "wfr_1")
    ).toBe(false);
    expect(
      hasTerminalWorkflowTaskAwaitInParts(error({ id: "wfr_2", status: "failed" }), "wfr_1")
    ).toBe(false);
  });
});

describe("hasTerminalWorkflowToolOutputInParts", () => {
  const runPart = (fields: Record<string, unknown>) => ({
    type: "dynamic-tool",
    toolCallId: "c1",
    toolName: "workflow_run",
    state: "output-available",
    input: {},
    output: { runId: "wfr_1", status: "completed" },
    ...fields,
  });

  test("a finished workflow_run output for the run is terminal", () => {
    expect(hasTerminalWorkflowToolOutputInParts([runPart({})], "wfr_1")).toBe(true);
  });

  test("an unfinished call or another part type is not", () => {
    expect(
      hasTerminalWorkflowToolOutputInParts([runPart({ state: "input-available" })], "wfr_1")
    ).toBe(false);
    expect(hasTerminalWorkflowToolOutputInParts([runPart({ type: "text" })], "wfr_1")).toBe(false);
  });
});

describe("auto-compaction rows with partial metadata", () => {
  test("a row without follow-up options counts as a manual supersession", () => {
    const partial = (parsed: unknown) =>
      message({
        role: "user",
        metadata: {
          synthetic: true,
          muxMetadata: { type: "compaction-request", source: "auto-compaction", parsed },
        },
      });
    expect(isWorkflowSupersessionMessage(partial({}))).toBe(true);
    expect(isWorkflowSupersessionMessage(partial({ followUpContent: {} }))).toBe(true);
    expect(isCompactionRequestMessage(message({ role: "user", metadata: {} }))).toBe(false);
  });
});
