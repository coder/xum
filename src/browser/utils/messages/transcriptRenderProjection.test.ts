import { describe, expect, test } from "bun:test";
import type { DisplayedMessage } from "@/common/types/message";
import {
  computeOperationalBundleInfos,
  computeTaskAwaitPollGroupInfos,
  computeWorkBundleInfos,
  estimateTranscriptRowWeight,
  summarizeOperationalBundle,
} from "./transcriptRenderProjection";

let nextToolId = 0;

function tool(
  overrides: Partial<DisplayedMessage & { type: "tool" }>
): DisplayedMessage & { type: "tool" } {
  const id = overrides.id ?? `tool-${++nextToolId}`;
  return {
    type: "tool",
    id,
    historyId: overrides.historyId ?? `history-${id}`,
    toolCallId: overrides.toolCallId ?? `call-${id}`,
    toolName: overrides.toolName ?? "file_read",
    args: overrides.args ?? {},
    result: overrides.result,
    status: overrides.status ?? "completed",
    isPartial: overrides.isPartial ?? false,
    historySequence: overrides.historySequence ?? 1,
    isLastPartOfMessage: overrides.isLastPartOfMessage,
    timestamp: overrides.timestamp,
    nestedCalls: overrides.nestedCalls,
  };
}

function reasoning(
  overrides: Partial<DisplayedMessage & { type: "reasoning" }> = {}
): DisplayedMessage & { type: "reasoning" } {
  const id = overrides.id ?? "reasoning-1";
  return {
    type: "reasoning",
    id,
    historyId: overrides.historyId ?? `history-${id}`,
    content: overrides.content ?? "Thinking through the plan",
    historySequence: overrides.historySequence ?? 1,
    isStreaming: overrides.isStreaming ?? false,
    isPartial: overrides.isPartial ?? false,
    isLastPartOfMessage: overrides.isLastPartOfMessage,
    isOnlyMessageContent: overrides.isOnlyMessageContent,
    timestamp: overrides.timestamp,
  };
}

function user(id: string): DisplayedMessage {
  return {
    type: "user",
    id,
    historyId: `history-${id}`,
    content: "hello",
    historySequence: 1,
  };
}

function assistant(
  id: string,
  overrides: Partial<DisplayedMessage & { type: "assistant" }> = {}
): DisplayedMessage & { type: "assistant" } {
  return {
    type: "assistant",
    id,
    historyId: overrides.historyId ?? `history-${id}`,
    content: overrides.content ?? "done",
    historySequence: overrides.historySequence ?? 1,
    isStreaming: overrides.isStreaming ?? false,
    isPartial: overrides.isPartial ?? false,
    isLastPartOfMessage: overrides.isLastPartOfMessage,
    isCompacted: overrides.isCompacted ?? false,
    isIdleCompacted: overrides.isIdleCompacted ?? false,
    timestamp: overrides.timestamp,
  };
}

function streamError(id: string, historyId: string): DisplayedMessage & { type: "stream-error" } {
  return {
    type: "stream-error",
    id,
    historyId,
    error: "Provider error",
    errorType: "api",
    historySequence: 1,
  };
}

function planDisplay(id: string, historyId: string): DisplayedMessage & { type: "plan-display" } {
  return {
    type: "plan-display",
    id,
    historyId,
    content: "# Plan",
    path: ".mux/plan.md",
    historySequence: 1,
  };
}

describe("estimateTranscriptRowWeight", () => {
  test("charges a stream error for the text it mounts, not a nominal marker", () => {
    const verbose = { ...streamError("e1", "h-e1"), error: "x".repeat(50_000) };
    const marker = streamError("e2", "h-e2");
    // Distinct verbose failures are not merged, so a run of them would otherwise mount far more
    // than the step ceiling accounts for.
    expect(estimateTranscriptRowWeight(verbose)).toBeGreaterThanOrEqual(50_000);
    expect(estimateTranscriptRowWeight(verbose) - estimateTranscriptRowWeight(marker)).toBe(
      50_000 - marker.error.length
    );
  });
});

describe("work bundle coalescing", () => {
  test("collapses completed assistant work before the final row", () => {
    const messages = [
      user("u1"),
      reasoning({ id: "think-1", historyId: "history-a1", timestamp: 1_000 }),
      assistant("draft-1", {
        historyId: "history-a1",
        content: "I'll inspect first.",
        timestamp: 61_000,
      }),
      tool({ id: "read-1", historyId: "history-a1", timestamp: 121_000 }),
      assistant("final-1", {
        historyId: "history-a1",
        content: "Implemented the fix.",
        timestamp: 181_000,
      }),
    ];

    const infos = computeWorkBundleInfos(messages);

    expect(infos[0]).toMatchObject({
      key: "work:think-1",
      position: "head",
      headIndex: 0,
      durationMs: 180_000,
      defaultExpanded: false,
      entries: [
        { message: messages[1], originalIndex: 1 },
        { message: messages[2], originalIndex: 2 },
        { message: messages[3], originalIndex: 3 },
        { message: messages[4], originalIndex: 4 },
      ],
    });
    expect(infos[1]).toMatchObject({ key: "work:think-1", position: "member" });
    expect(infos[2]).toMatchObject({ key: "work:think-1", position: "member" });
    expect(infos[3]).toMatchObject({ key: "work:think-1", position: "member" });
    expect(infos[4]).toMatchObject({ key: "work:think-1", position: "final" });
  });

  test("omits work duration when timestamps are missing", () => {
    const historyId = "history-a1";
    const messages = [tool({ id: "read-1", historyId }), assistant("final-1", { historyId })];

    const infos = computeWorkBundleInfos(messages);

    expect(infos[0]).toMatchObject({ durationMs: undefined });
  });

  test("keeps operational bundle metadata aligned inside work bundles", () => {
    const historyId = "history-a1";
    const messages = [
      reasoning({ id: "think-1", historyId }),
      assistant("draft-1", { historyId }),
      tool({ id: "read-1", historyId, toolName: "file_read" }),
      tool({ id: "skill-1", historyId, toolName: "agent_skill_read" }),
      assistant("final-1", { historyId }),
    ];

    const workInfos = computeWorkBundleInfos(messages);
    const operationalInfos = computeOperationalBundleInfos(messages, { isTurnActive: false });

    expect(workInfos[0]?.entries.map((entry) => entry.originalIndex)).toEqual([0, 1, 2, 3, 4]);
    expect(operationalInfos[2]).toMatchObject({
      position: "head",
      headIndex: 2,
      entries: [
        { message: messages[0], originalIndex: 0 },
        { message: messages[2], originalIndex: 2 },
        { message: messages[3], originalIndex: 3 },
      ],
    });
  });

  test("spans steering user messages until the turn final assistant row", () => {
    const messages = [
      user("u1"),
      tool({
        id: "read-1",
        historyId: "history-a1",
        isPartial: true,
        status: "executing",
        timestamp: 1_000,
      }),
      user("steer-1"),
      tool({ id: "bash-1", historyId: "history-a1", toolName: "bash", timestamp: 31_000 }),
      assistant("final-1", { historyId: "history-a1", timestamp: 61_000 }),
    ];

    const infos = computeWorkBundleInfos(messages);

    expect(infos[0]).toMatchObject({
      key: "work:read-1",
      position: "head",
      headIndex: 0,
      durationMs: 60_000,
      entries: [
        { message: messages[1], originalIndex: 1 },
        { message: messages[2], originalIndex: 2 },
        { message: messages[3], originalIndex: 3 },
        { message: messages[4], originalIndex: 4 },
      ],
    });
    expect(infos[1]).toMatchObject({ key: "work:read-1", position: "member" });
    expect(infos[2]).toMatchObject({ key: "work:read-1", position: "member" });
    expect(infos[3]).toMatchObject({ key: "work:read-1", position: "member" });
    expect(infos[4]).toMatchObject({ key: "work:read-1", position: "final" });
  });

  test("does not finalize work bundles before the first operation", () => {
    const messages = [
      user("u1"),
      assistant("draft-1", { historyId: "history-a1", content: "I'll inspect first." }),
      tool({ id: "read-1", historyId: "history-a1" }),
    ];

    const infos = computeWorkBundleInfos(messages);

    expect(infos.every((info) => info === undefined)).toBe(true);
  });

  test("does not merge completed partial tools into a tool-using next prompt", () => {
    const messages = [
      user("u1"),
      tool({ id: "read-1", historyId: "history-a1", isPartial: true, status: "completed" }),
      user("u2"),
      tool({ id: "bash-1", historyId: "history-a2", toolName: "bash" }),
      assistant("final-2", { historyId: "history-a2" }),
    ];

    const infos = computeWorkBundleInfos(messages);

    expect(infos[0]).toBeUndefined();
    expect(infos[1]).toBeUndefined();
    expect(infos[2]).toMatchObject({ key: "work:bash-1", position: "head", headIndex: 2 });
    expect(infos[3]).toMatchObject({ key: "work:bash-1", position: "member" });
    expect(infos[4]).toMatchObject({ key: "work:bash-1", position: "final" });
  });

  test("does not merge interrupted partial tools into a text-only next prompt", () => {
    const messages = [
      user("u1"),
      tool({ id: "read-1", historyId: "history-a1", isPartial: true }),
      user("u2"),
      assistant("answer-2", { historyId: "history-a2" }),
    ];

    const infos = computeWorkBundleInfos(messages);

    expect(infos.every((info) => info === undefined)).toBe(true);
  });

  test("does not merge mixed partial tool and text interruptions across the next user prompt", () => {
    const messages = [
      user("u1"),
      tool({ id: "read-1", historyId: "history-a1", isPartial: true }),
      assistant("draft-1", { historyId: "history-a1", isPartial: true }),
      user("u2"),
      tool({ id: "bash-1", historyId: "history-a2", toolName: "bash" }),
      assistant("final-2", { historyId: "history-a2" }),
    ];

    const infos = computeWorkBundleInfos(messages);

    expect(infos[0]).toBeUndefined();
    expect(infos[1]).toBeUndefined();
    expect(infos[2]).toBeUndefined();
    expect(infos[3]).toMatchObject({ key: "work:bash-1", position: "head", headIndex: 3 });
    expect(infos[4]).toMatchObject({ key: "work:bash-1", position: "member" });
    expect(infos[5]).toMatchObject({ key: "work:bash-1", position: "final" });
  });

  test("does not merge partial text-only interruptions across the next user prompt", () => {
    const messages = [
      user("u1"),
      reasoning({ id: "think-1", historyId: "history-a1", isPartial: true }),
      assistant("draft-1", { historyId: "history-a1", isPartial: true }),
      user("u2"),
      tool({ id: "bash-1", historyId: "history-a2", toolName: "bash" }),
      assistant("final-2", { historyId: "history-a2" }),
    ];

    const infos = computeWorkBundleInfos(messages);

    expect(infos[0]).toBeUndefined();
    expect(infos[1]).toBeUndefined();
    expect(infos[2]).toBeUndefined();
    expect(infos[3]).toMatchObject({ key: "work:bash-1", position: "head", headIndex: 3 });
    expect(infos[4]).toMatchObject({ key: "work:bash-1", position: "member" });
    expect(infos[5]).toMatchObject({ key: "work:bash-1", position: "final" });
  });

  test("does not merge interrupted work across the next user prompt", () => {
    const messages = [
      user("u1"),
      tool({ id: "interrupted-1", historyId: "history-a1", status: "interrupted" }),
      user("u2"),
      tool({ id: "bash-1", historyId: "history-a2", toolName: "bash" }),
      assistant("final-2", { historyId: "history-a2" }),
    ];

    const infos = computeWorkBundleInfos(messages);

    expect(infos[1]).toBeUndefined();
    expect(infos[2]).toMatchObject({ key: "work:bash-1", position: "head", headIndex: 2 });
    expect(infos[3]).toMatchObject({
      key: "work:bash-1",
      entries: [
        { message: messages[3], originalIndex: 3 },
        { message: messages[4], originalIndex: 4 },
      ],
    });
    expect(infos[4]).toMatchObject({ key: "work:bash-1", position: "final" });
  });

  test("does not merge completed turns across the next user message", () => {
    const messages = [
      user("u1"),
      tool({ id: "read-1", historyId: "history-a1" }),
      assistant("final-1", { historyId: "history-a1" }),
      user("u2"),
      tool({ id: "bash-1", historyId: "history-a2", toolName: "bash" }),
      assistant("final-2", { historyId: "history-a2" }),
    ];

    const infos = computeWorkBundleInfos(messages);

    expect(infos[0]).toMatchObject({
      key: "work:read-1",
      position: "head",
      entries: [
        { message: messages[1], originalIndex: 1 },
        { message: messages[2], originalIndex: 2 },
      ],
    });
    expect(infos[2]).toMatchObject({ key: "work:read-1", position: "final" });
    expect(infos[3]).toMatchObject({ key: "work:bash-1", position: "head" });
    expect(infos[4]).toMatchObject({
      key: "work:bash-1",
      entries: [
        { message: messages[4], originalIndex: 4 },
        { message: messages[5], originalIndex: 5 },
      ],
    });
    expect(infos[5]).toMatchObject({ key: "work:bash-1", position: "final" });
  });

  test("wraps active work in an expanded working bundle", () => {
    const messages = [
      user("u1"),
      assistant("draft-1", { historyId: "history-a1" }),
      tool({ id: "read-1", historyId: "history-a1", status: "executing" }),
    ];

    const infos = computeWorkBundleInfos(messages);

    expect(infos[0]).toMatchObject({
      key: "work:draft-1",
      position: "head",
      state: "active",
      defaultExpanded: true,
      entries: [
        { message: messages[1], originalIndex: 1 },
        { message: messages[2], originalIndex: 2 },
      ],
    });
    expect(infos[1]).toMatchObject({ key: "work:draft-1", position: "member" });
    expect(infos[2]).toMatchObject({ key: "work:draft-1", position: "member" });
  });

  test("collapses non-success tools before a final assistant row", () => {
    const historyId = "history-a1";
    const failedSearch = tool({
      id: "search-1",
      historyId,
      toolName: "web_search",
      status: "failed",
      result: { error: "provider unavailable" },
    });
    const failedBash = tool({
      id: "bash-1",
      historyId,
      toolName: "bash",
      status: "failed",
      result: { exitCode: 1, output: "type error" },
    });
    const interruptedRead = tool({
      id: "read-interrupted-1",
      historyId,
      toolName: "file_read",
      status: "interrupted",
    });
    const redactedRead = tool({
      id: "read-redacted-1",
      historyId,
      toolName: "file_read",
      status: "redacted",
    });
    const partialRead = tool({
      id: "read-partial-1",
      historyId,
      toolName: "file_read",
      isPartial: true,
    });
    const messages = [
      failedSearch,
      failedBash,
      interruptedRead,
      redactedRead,
      partialRead,
      assistant("final-1", { historyId }),
    ];

    const infos = computeWorkBundleInfos(messages);

    expect(infos[0]).toMatchObject({
      key: "work:search-1",
      position: "head",
      entries: [
        { message: failedSearch, originalIndex: 0 },
        { message: failedBash, originalIndex: 1 },
        { message: interruptedRead, originalIndex: 2 },
        { message: redactedRead, originalIndex: 3 },
        { message: partialRead, originalIndex: 4 },
        { message: messages[5], originalIndex: 5 },
      ],
    });
    expect(infos[1]).toMatchObject({ key: "work:search-1", position: "member" });
    expect(infos[2]).toMatchObject({ key: "work:search-1", position: "member" });
    expect(infos[3]).toMatchObject({ key: "work:search-1", position: "member" });
    expect(infos[4]).toMatchObject({ key: "work:search-1", position: "member" });
    expect(infos[5]).toMatchObject({ key: "work:search-1", position: "final" });
  });

  test("keeps stream errors and plan displays out of work bundles", () => {
    const historyId = "history-a1";
    const messages = [
      reasoning({ id: "think-1", historyId }),
      tool({ id: "read-1", historyId }),
      streamError("error-1", historyId),
      planDisplay("plan-1", historyId),
    ];

    const infos = computeWorkBundleInfos(messages);

    expect(infos.every((info) => info === undefined)).toBe(true);
  });
});

describe("task_await poll grouping", () => {
  test("leaves standalone waits visible and collapses consecutive polls", () => {
    const first = tool({ id: "await-1", toolName: "task_await", status: "completed" });
    const second = tool({ id: "await-2", toolName: "task_await", status: "executing" });

    expect(computeTaskAwaitPollGroupInfos([first])[0]).toBeUndefined();

    const infos = computeTaskAwaitPollGroupInfos([first, second]);
    expect(infos[0]).toMatchObject({
      position: "head",
      state: "active",
      defaultExpanded: false,
      summary: {
        title: "Checked task status 2 times",
        activeTitle: "Waiting for tasks · 2 checks",
        details: "",
      },
    });
    expect(infos[1]).toMatchObject({ position: "member", defaultExpanded: false });
  });

  test("expands poll groups with terminal failures", () => {
    const infos = computeTaskAwaitPollGroupInfos([
      tool({
        id: "await-running",
        toolName: "task_await",
        result: { results: [{ status: "running", taskId: "task-1" }] },
      }),
      tool({
        id: "await-failed",
        toolName: "task_await",
        result: { results: [{ status: "error", taskId: "task-1", error: "failed" }] },
      }),
    ]);

    expect(infos[0]).toMatchObject({
      defaultExpanded: true,
      summary: {
        title: "Task wait needs attention",
        activeTitle: "Task wait needs attention",
        details: "2 checks",
        tone: "danger",
      },
    });
  });

  test("expands groups with call-level task_await failures", () => {
    const infos = computeTaskAwaitPollGroupInfos([
      tool({
        id: "await-running",
        toolName: "task_await",
        result: { results: [{ status: "running", taskId: "task-1" }] },
      }),
      tool({
        id: "await-call-failed",
        toolName: "task_await",
        status: "failed",
        result: { success: false, error: "service unavailable" },
      }),
    ]);

    expect(infos[0]).toMatchObject({
      defaultExpanded: true,
      summary: { title: "Task wait needs attention", tone: "danger" },
    });
  });

  test("expands groups with call-level interruptions", () => {
    const infos = computeTaskAwaitPollGroupInfos([
      tool({ id: "await-running", toolName: "task_await" }),
      tool({
        id: "await-interrupted",
        toolName: "task_await",
        status: "interrupted",
      }),
    ]);

    expect(infos[0]).toMatchObject({
      defaultExpanded: true,
      summary: { title: "Task wait interrupted", tone: "interrupted" },
    });
  });

  test("classifies interrupted error rows as cancelled waits", () => {
    const infos = computeTaskAwaitPollGroupInfos([
      tool({ id: "await-running", toolName: "task_await" }),
      tool({
        id: "await-aborted",
        toolName: "task_await",
        result: { results: [{ status: "error", taskId: "task-1", error: "Interrupted" }] },
      }),
    ]);

    expect(infos[0]).toMatchObject({
      defaultExpanded: true,
      summary: { title: "Task wait interrupted", tone: "interrupted" },
    });
  });

  test("conversation rows break poll groups", () => {
    const infos = computeTaskAwaitPollGroupInfos([
      tool({ id: "await-1", toolName: "task_await" }),
      assistant("a1"),
      tool({ id: "await-2", toolName: "task_await" }),
    ]);

    expect(infos.every((info) => info === undefined)).toBe(true);
  });
});

describe("operational bundle coalescing", () => {
  test("groups consecutive reasoning and tool calls without mutating messages", () => {
    const first = reasoning({ id: "think-1" });
    const second = tool({ id: "read-1", toolName: "file_read" });
    const third = tool({ id: "edit-1", toolName: "file_edit_replace_string" });
    const messages = [user("u1"), first, assistant("a1"), second, third, assistant("a2")];
    const before = JSON.stringify(messages);

    const infos = computeOperationalBundleInfos(messages, { isTurnActive: false });

    expect(JSON.stringify(messages)).toBe(before);
    expect(infos[0]).toBeUndefined();
    expect(infos[1]).toMatchObject({ key: "bundle:think-1", position: "member", headIndex: 3 });
    expect(infos[2]).toBeUndefined();
    expect(infos[3]).toMatchObject({
      key: "bundle:think-1",
      position: "head",
      headIndex: 3,
      state: "settled",
      defaultExpanded: false,
      entries: [
        { message: first, originalIndex: 1 },
        { message: second, originalIndex: 3 },
        { message: third, originalIndex: 4 },
      ],
    });
    expect(infos[4]).toMatchObject({ key: "bundle:think-1", position: "member" });
    expect(infos[5]).toBeUndefined();
  });

  test("conversation rows break bundles", () => {
    const messages = [
      tool({ id: "read-1", toolName: "file_read" }),
      assistant("a1"),
      tool({ id: "edit", toolName: "file_edit_replace_string" }),
      user("u1"),
      tool({ id: "read-2", toolName: "agent_skill_read" }),
    ];

    const infos = computeOperationalBundleInfos(messages, { isTurnActive: false });

    expect(infos[0]).toMatchObject({ position: "head" });
    expect(infos[1]).toBeUndefined();
    expect(infos[2]).toMatchObject({ position: "head" });
    expect(infos[3]).toBeUndefined();
    expect(infos[4]).toMatchObject({ position: "head" });
  });

  test("assistant rows split non-success operational bundles", () => {
    const first = tool({ id: "bash-1", toolName: "bash", status: "failed" });
    const middle = assistant("a1");
    const second = tool({ id: "bash-2", toolName: "bash", status: "failed" });

    const infos = computeOperationalBundleInfos([first, middle, second], {
      isTurnActive: false,
    });

    expect(infos[0]).toMatchObject({
      key: "bundle:bash-1",
      position: "head",
      entries: [{ message: first, originalIndex: 0 }],
    });
    expect(infos[1]).toBeUndefined();
    expect(infos[2]).toMatchObject({
      key: "bundle:bash-2",
      position: "head",
      entries: [{ message: second, originalIndex: 2 }],
    });
  });

  test("leaves reasoning-only turns visible", () => {
    const message = reasoning({ id: "think-only", isOnlyMessageContent: true });

    const infos = computeOperationalBundleInfos([message], { isTurnActive: false });

    expect(infos[0]).toBeUndefined();
  });

  test("does not duplicate leading reasoning when it is the bundle head", () => {
    const first = reasoning({ id: "think-1" });
    const second = tool({ id: "read-1", toolName: "file_read" });

    const reasoningOnly = computeOperationalBundleInfos([first], { isTurnActive: false });
    expect(reasoningOnly[0]?.entries).toEqual([{ message: first, originalIndex: 0 }]);
    expect(reasoningOnly[0]?.summary.title).toBe("Reasoned");

    const reasoningThenTool = computeOperationalBundleInfos([first, second], {
      isTurnActive: false,
    });
    expect(reasoningThenTool[0]?.entries).toEqual([
      { message: first, originalIndex: 0 },
      { message: second, originalIndex: 1 },
    ]);
    expect(reasoningThenTool[0]?.summary.title).toBe("Ran 2 operations");
  });

  test("groups non-success tools into operational bundles", () => {
    const failedSearch = tool({
      id: "search-1",
      toolName: "web_search",
      status: "failed",
      result: { error: "provider unavailable" },
    });
    const failedBash = tool({
      id: "bash-1",
      toolName: "bash",
      status: "failed",
      result: { exitCode: 1, output: "type error" },
    });
    const interruptedRead = tool({
      id: "read-interrupted-1",
      toolName: "file_read",
      status: "interrupted",
    });
    const redactedRead = tool({
      id: "read-redacted-1",
      toolName: "file_read",
      status: "redacted",
    });
    const partialRead = tool({
      id: "read-partial-1",
      toolName: "file_read",
      isPartial: true,
    });

    const infos = computeOperationalBundleInfos(
      [failedSearch, failedBash, interruptedRead, redactedRead, partialRead],
      { isTurnActive: false }
    );

    expect(infos[0]).toMatchObject({
      key: "bundle:search-1",
      position: "head",
      state: "settled",
      defaultExpanded: false,
      entries: [
        { message: failedSearch, originalIndex: 0 },
        { message: failedBash, originalIndex: 1 },
        { message: interruptedRead, originalIndex: 2 },
        { message: redactedRead, originalIndex: 3 },
        { message: partialRead, originalIndex: 4 },
      ],
      summary: {
        title: "Ran 5 operations",
        details: "1 search · 1 shell command · 3 reads",
      },
    });
    expect(infos[1]).toMatchObject({ key: "bundle:search-1", position: "member" });
    expect(infos[2]).toMatchObject({ key: "bundle:search-1", position: "member" });
    expect(infos[3]).toMatchObject({ key: "bundle:search-1", position: "member" });
    expect(infos[4]).toMatchObject({ key: "bundle:search-1", position: "member" });
  });

  test("keeps active bundles expanded while completed bundles default collapsed", () => {
    const active = computeOperationalBundleInfos(
      [reasoning({ id: "think-1", isStreaming: true })],
      {
        isTurnActive: true,
      }
    );
    expect(active[0]).toMatchObject({
      position: "head",
      state: "active",
      defaultExpanded: true,
    });

    const justSettledTail = computeOperationalBundleInfos(
      [tool({ id: "read-1", status: "completed" })],
      { isTurnActive: true }
    );
    expect(justSettledTail[0]).toMatchObject({
      position: "head",
      state: "settled",
      defaultExpanded: false,
    });

    const afterVisibleEvent = computeOperationalBundleInfos(
      [tool({ id: "read-1", status: "completed" }), assistant("a1")],
      { isTurnActive: true }
    );
    expect(afterVisibleEvent[0]).toMatchObject({
      position: "head",
      state: "settled",
      defaultExpanded: false,
    });
  });

  test("keeps task_await operational bundles quiet unless they need attention", () => {
    const active = computeOperationalBundleInfos(
      [
        tool({
          id: "await-active",
          toolName: "task_await",
          status: "executing",
          result: { results: [{ status: "running", taskId: "task-1" }] },
        }),
      ],
      { isTurnActive: true }
    );
    expect(active[0]).toMatchObject({ defaultExpanded: false });

    const failed = computeOperationalBundleInfos(
      [
        tool({
          id: "await-failed",
          toolName: "task_await",
          result: { results: [{ status: "not_found", taskId: "task-1" }] },
        }),
      ],
      { isTurnActive: false }
    );
    expect(failed[0]).toMatchObject({
      defaultExpanded: true,
      summary: { title: "Task wait needs attention", tone: "danger" },
    });
  });

  test("bundle key stays stable while an active bundle grows", () => {
    const one = computeOperationalBundleInfos([tool({ id: "read-1", status: "executing" })], {
      isTurnActive: true,
    });
    const two = computeOperationalBundleInfos(
      [tool({ id: "read-1", status: "executing" }), tool({ id: "search-1" })],
      { isTurnActive: true }
    );

    expect(one[0]?.key).toBe("bundle:read-1");
    expect(two[0]?.key).toBe("bundle:read-1");
    expect(two[1]).toMatchObject({ key: "bundle:read-1", position: "member" });
  });
});

describe("operational bundle summary", () => {
  test("uses task-specific copy for repeated task_await polls", () => {
    const summary = summarizeOperationalBundle([
      tool({ id: "await-1", toolName: "task_await" }),
      tool({ id: "await-2", toolName: "task_await" }),
      tool({ id: "await-3", toolName: "task_await" }),
    ]);

    expect(summary).toEqual({
      title: "Checked task status 3 times",
      activeTitle: "Waiting for tasks · 3 checks",
      details: "",
    });
  });

  test("summarizes mixed tools and reasoning", () => {
    const summary = summarizeOperationalBundle([
      reasoning({ id: "think-1" }),
      tool({ id: "edit-1", toolName: "file_edit_replace_string" }),
      tool({ id: "test-1", toolName: "bash", args: { script: "make test" } }),
      tool({ id: "question-1", toolName: "ask_user_question" }),
    ]);

    expect(summary.title).toBe("Ran 4 operations");
    expect(summary.details).toBe("1 reasoning step · 1 edit · 1 shell command · 1 question");
  });

  test("pluralizes irregular detail labels", () => {
    const summary = summarizeOperationalBundle([
      tool({ id: "search-1", toolName: "web_search", result: [{ title: "one" }] }),
      tool({ id: "search-2", toolName: "web_search", result: [{ title: "two" }] }),
      tool({ id: "fetch-1", toolName: "web_fetch" }),
      tool({ id: "fetch-2", toolName: "web_fetch" }),
    ]);

    expect(summary.details).toBe("2 searches · 2 fetches");
  });

  test("categorizes Google native search grounding as a search", () => {
    const summary = summarizeOperationalBundle([
      tool({
        id: "gsearch-1",
        toolName: "server:GOOGLE_SEARCH_WEB",
        args: { queries: ["electron 34 release date"] },
        result: { search_suggestions: "<div></div>" },
      }),
      tool({ id: "search-1", toolName: "web_search", result: [{ title: "one" }] }),
    ]);

    expect(summary.details).toBe("2 searches");
  });

  test("all-miss completed search bundle gets neutral copy", () => {
    const allMiss = summarizeOperationalBundle([
      tool({ id: "search-1", toolName: "web_search", status: "completed", result: [] }),
      tool({
        id: "search-2",
        toolName: "web_search",
        status: "completed",
        result: { type: "json", value: { sources: [] } },
      }),
    ]);
    expect(allMiss.title).toBe("No results");
  });

  test("failed search summaries do not use no-results copy", () => {
    const failedSearch = summarizeOperationalBundle([
      tool({
        id: "search-1",
        toolName: "web_search",
        status: "failed",
        result: { error: "provider unavailable" },
      }),
    ]);
    expect(failedSearch.title).toBe("Searched 1 query");
  });
});
