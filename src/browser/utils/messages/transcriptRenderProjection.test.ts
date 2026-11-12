import { describe, expect, test } from "bun:test";
import { TRANSCRIPT_REVEAL_STEP_CHARS } from "@/common/constants/ui";
import type { DisplayedMessage } from "@/common/types/message";
import { BACKGROUND_WORK_WAKE_OPENINGS } from "@/common/utils/machineTurnPrompts";
import {
  computeOperationalBundleInfos,
  computeWindowRowIndices,
  computeWorkBundleInfos,
  estimateTranscriptRowWeight,
  selectTranscriptWindowRows,
  summarizeOperationalBundle,
  type WorkBundleInfo,
} from "./transcriptRenderProjection";

// Task polls are routine calls: a run of them folds like any other routine run.
function computeTaskAwaitPollGroupInfos(messages: DisplayedMessage[]) {
  return computeOperationalBundleInfos(messages, { isTurnActive: false });
}

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

function user(id: string, timestamp?: number): DisplayedMessage & { type: "user" } {
  return {
    type: "user",
    id,
    historyId: `history-${id}`,
    content: "hello",
    historySequence: 1,
    timestamp,
  };
}

/** A prompt the machine wrote mid-turn: the wake-up for finished sub-agents. */
function wake(id: string, timestamp?: number): DisplayedMessage {
  return {
    ...user(id, timestamp),
    content: `${BACKGROUND_WORK_WAKE_OPENINGS.subagentsCompleted} Read the reports.`,
    isSynthetic: true,
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

  test("charges tool payload nested inside result wrappers, not only top-level strings", () => {
    const wrapped = tool({
      id: "t1",
      historyId: "h-t1",
      timestamp: 1,
      result: { type: "json", value: { content: [{ type: "text", text: "y".repeat(40_000) }] } },
    });
    const flat = tool({ id: "t2", historyId: "h-t2", timestamp: 1, result: "y".repeat(40_000) });
    // A `{ type: "json", value }` result is serialized in full by an expanded card, so it must
    // weigh like the same text delivered as a plain string.
    expect(estimateTranscriptRowWeight(wrapped)).toBeGreaterThanOrEqual(40_000);
    expect(estimateTranscriptRowWeight(wrapped)).toBeGreaterThanOrEqual(
      estimateTranscriptRowWeight(flat)
    );
  });

  test("stops charging a wide payload once it exceeds one reveal step", () => {
    const wide = (fields: number) =>
      tool({
        id: `w-${fields}`,
        historyId: `h-w-${fields}`,
        timestamp: 1,
        result: Array.from({ length: fields }, () => "z".repeat(1_000)),
      });
    // The caller only needs "heavier than one step": a result ten times wider weighs the same.
    const saturated = estimateTranscriptRowWeight(wide(1_000));
    expect(saturated).toBeGreaterThan(TRANSCRIPT_REVEAL_STEP_CHARS);
    expect(estimateTranscriptRowWeight(wide(10_000))).toBe(saturated);
  });
});

describe("work bundles (compact density)", () => {
  // One assistant message: its rows share a history id.
  const TURN = { historyId: "history-turn" };

  function work(messages: DisplayedMessage[], isTurnActive = false) {
    return computeWorkBundleInfos(messages, { isTurnActive });
  }
  const lines = (infos: Array<WorkBundleInfo | undefined>) => infos.map((info) => info?.key);

  test("keeps what the agent wrote in view and folds the steps between into one line each", () => {
    const infos = work([
      user("prompt"),
      reasoning({ id: "think", ...TURN }),
      assistant("update-1", TURN),
      tool({ id: "read-a", ...TURN }),
      tool({ id: "read-b", ...TURN }),
      tool({ id: "tests", toolName: "bash", ...TURN }),
      assistant("update-2", TURN),
      tool({ id: "edit", toolName: "file_edit_insert", status: "failed", ...TURN }),
      assistant("reply", TURN),
      tool({ id: "todo", toolName: "todo_write", ...TURN }),
    ]);

    // Every update and the reply are plain rows. Each run of steps between them is a stretch.
    expect(lines(infos)).toEqual([
      undefined,
      "work:think",
      undefined,
      "work:read-a",
      "work:read-a",
      "work:read-a",
      undefined,
      "work:edit",
      undefined,
      "work:todo",
    ]);
    expect(infos[5]).toMatchObject({ headIndex: 3, state: "settled", visibleWhenFolded: false });
    // The line says what its steps did, and that one of them failed.
    expect(infos.map((info) => info?.summary).filter((summary) => summary !== undefined)).toEqual([
      "Thought",
      "Read 2 files, ran 1 command",
      "Read 2 files, ran 1 command",
      "Read 2 files, ran 1 command",
      "Edited 1 file · 1 failed",
      "Updated the todo list",
    ]);
  });

  test("folds a machine prompt with the steps around it, across the messages of a turn", () => {
    // A sub-agent finished mid-work: the wake-up is a step like the calls on either side of it.
    const midWork = work([
      user("prompt"),
      tool({ id: "read-a", historyId: "history-a" }),
      wake("wake"),
      tool({ id: "read-b", historyId: "history-b" }),
      assistant("reply", { historyId: "history-b" }),
    ]);
    expect(lines(midWork)).toEqual([
      undefined,
      "work:read-a",
      "work:read-a",
      "work:read-a",
      undefined,
    ]);
    // The prompt itself is not something the agent did.
    expect(midWork[1]?.summary).toBe("Read 2 files");

    // After something the agent wrote, the wake-up heads the stretch it starts.
    const afterReply = work([
      user("prompt"),
      tool({ id: "read-a", historyId: "history-a" }),
      assistant("reply-a", { historyId: "history-a" }),
      wake("wake"),
      tool({ id: "read-b", historyId: "history-b" }),
      assistant("reply-b", { historyId: "history-b" }),
    ]);
    expect(lines(afterReply)).toEqual([
      undefined,
      "work:read-a",
      undefined,
      "work:wake",
      "work:wake",
      undefined,
    ]);
  });

  test("leaves a machine prompt the agent has not acted on as its own row", () => {
    expect(work([user("prompt"), wake("wake")])).toEqual([undefined, undefined]);
    // With only a reply after it there is still nothing to fold.
    expect(work([user("prompt"), wake("wake"), assistant("reply", TURN)])).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    // Once the agent takes a step, the prompt folds with it.
    const acted = work([user("prompt"), wake("wake"), reasoning({ id: "think", ...TURN })]);
    expect(lines(acted)).toEqual([undefined, "work:wake", "work:wake"]);
  });

  test("never folds a question, a plan or an error, and starts a new stretch after one", () => {
    const infos = work([
      tool({ id: "read-a", ...TURN }),
      tool({ id: "ask", toolName: "ask_user_question", ...TURN }),
      tool({ id: "read-b", ...TURN }),
      assistant("here-is-the-plan", TURN),
      tool({ id: "plan", toolName: "propose_plan", ...TURN }),
      streamError("error", TURN.historyId),
    ]);

    expect(lines(infos)).toEqual([
      "work:read-a",
      undefined,
      "work:read-b",
      undefined,
      undefined,
      undefined,
    ]);
    expect(infos[2]).toMatchObject({ headIndex: 2 });
  });

  test("never folds a tool row that carries an MCP App view, its own or a nested call's", () => {
    const appCall = {
      connection: { key: "dice", transport: "stdio" as const },
      identity: { name: "dice-mcp", version: "1.0.0" },
      source: "connection" as const,
      app: { resourceUri: "ui://dice/board.html" },
    };
    const infos = work([
      tool({ id: "read-a", ...TURN }),
      { ...tool({ id: "board", toolName: "mcp__dice__show_board", ...TURN }), mcpServer: appCall },
      tool({ id: "read-b", ...TURN }),
      tool({
        id: "script",
        toolName: "code_execution",
        ...TURN,
        nestedCalls: [
          {
            toolCallId: "nested-board",
            toolName: "mcp__dice__show_board",
            state: "output-available",
            mcpServer: appCall,
          },
        ],
      }),
      assistant("reply", TURN),
    ]);

    expect(lines(infos)).toEqual(["work:read-a", undefined, "work:read-b", undefined, undefined]);
  });

  test("names a live stretch's latest step on its line and mounts no row for it", () => {
    const update = assistant("update", TURN);
    const first = tool({ id: "read-1", args: { path: "src/auth/session.ts" }, ...TURN });
    const latest = tool({
      id: "tests",
      toolName: "bash",
      status: "executing",
      args: { script: "bun test", model_intent: "Running the unit tests" },
      ...TURN,
    });

    // Nothing shows under the line: a step that rendered in under it was gone again when the
    // next one started.
    const working = work([user("prompt"), update, first, latest], true);
    expect(working[1]).toBeUndefined();
    expect(working.slice(2)).toEqual([
      expect.objectContaining({ state: "live", visibleWhenFolded: false }),
      expect.objectContaining({ state: "live", visibleWhenFolded: false }),
    ]);
    expect(working[2]?.summary).toBe("Running the unit tests");

    // The line follows the stretch step by step.
    const stepOf = (...steps: DisplayedMessage[]) =>
      work([user("prompt"), ...steps], true)[1]?.summary;
    expect(stepOf(first)).toBe("Reading session.ts");
    expect(stepOf(first, reasoning({ isStreaming: true, ...TURN }))).toBe("Thinking");
    expect(
      stepOf(tool({ toolName: "file_edit_insert", args: { path: "README.md" }, ...TURN }))
    ).toBe("Editing README.md");
    // A command with no stated purpose, and a tool the line has no words for.
    expect(stepOf(tool({ toolName: "bash", args: { script: "ls" }, ...TURN }))).toBe(
      "Running a command"
    );
    expect(stepOf(tool({ toolName: "mcp_lookup", ...TURN }))).toBe("Using mcp_lookup");
    // A script is doing whatever its latest call does.
    const script = tool({
      toolName: "code_execution",
      status: "executing",
      nestedCalls: [
        {
          toolCallId: "n1",
          toolName: "file_read",
          input: { path: "a.ts" },
          state: "output-available",
        },
        {
          toolCallId: "n2",
          toolName: "web_search",
          input: { query: "x" },
          state: "input-available",
        },
      ],
      ...TURN,
    });
    expect(stepOf(script)).toBe("Searching the web");
    expect(stepOf(tool({ toolName: "code_execution", ...TURN }))).toBe("Running a script");
    // A prompt the machine has just handed the agent: no step of its own to name yet.
    expect(stepOf(first, wake("wake"))).toBe("Working");

    // Once the agent writes, the stretch is done: its line says what it did.
    const writing = work(
      [user("prompt"), first, latest, assistant("reply", { ...TURN, isStreaming: true })],
      true
    );
    expect(writing[1]).toMatchObject({ state: "settled", summary: "Read 1 file, ran 1 command" });
    expect(writing[3]).toBeUndefined();

    // The same steps are settled once the turn ends, and an earlier turn is never live.
    expect(work([user("prompt"), first, tool({ id: "done", ...TURN })], false)[2]).toMatchObject({
      state: "settled",
    });
    expect(work([first, assistant("reply", TURN), user("next")], true)[0]).toMatchObject({
      state: "settled",
    });
  });

  test("shows a call that waits for the user's approval through the fold, not one that only runs", () => {
    const waiting = tool({ id: "approval", toolName: "bash", status: "executing", ...TURN });
    const done = tool({ id: "read", ...TURN });
    const script = tool({
      id: "script",
      toolName: "code_execution",
      status: "executing",
      nestedCalls: [{ toolCallId: "nested-bash", toolName: "bash", state: "input-available" }],
      ...TURN,
    });
    const running = tool({ id: "tests", toolName: "bash", status: "executing", ...TURN });
    const messages = [waiting, done, script, running];

    // The approval card and its shortcuts are in the row: the call's own, or its script's.
    const infos = computeWorkBundleInfos(messages, {
      isTurnActive: true,
      approvalToolCallIds: new Set([waiting.toolCallId, "nested-bash"]),
    });
    expect(infos.map((info) => info?.visibleWhenFolded)).toEqual([true, false, true, false]);

    // With nothing to approve, a running call is only named on the line.
    expect(work(messages, true).map((info) => info?.visibleWhenFolded)).toEqual(
      Array<boolean>(4).fill(false)
    );
    // A running call keeps its stretch live on a host that does not report the turn.
    expect(work(messages, false)[0]).toMatchObject({
      state: "live",
      summary: "Running a command",
    });
  });

  // The row the transcript ends on when its turn was interrupted carries the control that
  // continues the turn. Further up, an interrupted row carries nothing and folds.
  test("shows the row an interrupted turn stopped on through the fold while it is the tail", () => {
    const stoppedOnCall = work([
      user("prompt"),
      tool({ id: "read", ...TURN }),
      tool({
        id: "tests",
        toolName: "bash",
        status: "interrupted",
        isPartial: true,
        isLastPartOfMessage: true,
        ...TURN,
      }),
    ]);
    expect(stoppedOnCall[1]).toMatchObject({ state: "settled", visibleWhenFolded: false });
    expect(stoppedOnCall[2]).toMatchObject({ state: "settled", visibleWhenFolded: true });

    const stoppedThought = reasoning({
      id: "think",
      isPartial: true,
      isLastPartOfMessage: true,
      ...TURN,
    });
    expect(work([user("prompt"), stoppedThought])[1]).toMatchObject({ visibleWhenFolded: true });
    // The conversation went on: the stopped row needs nobody.
    expect(work([user("prompt"), stoppedThought, user("next-prompt")])[1]).toMatchObject({
      visibleWhenFolded: false,
    });
  });
});

describe("mount window rows (compact density)", () => {
  const A = { historyId: "history-a" };
  const B = { historyId: "history-b" };

  function windowRows(messages: DisplayedMessage[], isTurnActive = false) {
    const indices = computeWindowRowIndices(computeWorkBundleInfos(messages, { isTurnActive }));
    return { indices, rows: selectTranscriptWindowRows(messages, indices) };
  }

  test("counts every row when no work is folded", () => {
    // Detailed density has no work lines.
    expect(computeWindowRowIndices(undefined)).toBeUndefined();
    // Nor does a compact transcript of plain exchanges.
    const messages = [user("prompt"), assistant("reply", A)];
    const { indices, rows } = windowRows(messages);
    expect(indices).toBeUndefined();
    expect(rows.rows).toBe(messages);
    expect(rows.toTranscriptIndex(2)).toBe(2);
    expect(rows.toWindowIndex(1)).toBe(1);
  });

  test("leaves out the steps folded behind a finished stretch's work line", () => {
    const messages = [
      user("prompt-1"),
      tool({ id: "read-1", ...A }),
      tool({ id: "read-2", ...A }),
      tool({ id: "read-3", ...A }),
      tool({ id: "read-4", ...A }),
      assistant("reply-1", A),
      user("prompt-2"),
      tool({ id: "read-5", ...B }),
      tool({ id: "read-6", ...B }),
      tool({ id: "read-7", ...B }),
    ];
    const { indices, rows } = windowRows(messages);

    // The first row of a stretch carries the work line, and its last row is where the window
    // may end (the transcript's newest row is always counted). What the agent wrote counts.
    expect(indices).toEqual([0, 1, 4, 5, 6, 7, 9]);
    expect(rows.rows.map((row) => row.id)).toEqual([
      "prompt-1",
      "read-1",
      "read-4",
      "reply-1",
      "prompt-2",
      "read-5",
      "read-7",
    ]);
  });

  test("counts every row of the live stretch, and a settled row that still needs the user", () => {
    const live = [
      user("prompt"),
      tool({ id: "read-1", ...A }),
      tool({ id: "read-2", ...A }),
      tool({ id: "tests", toolName: "bash", status: "executing", ...A }),
    ];
    // Rows that came and went under the tail would read as a replaced tail.
    expect(windowRows(live, true).indices).toBeUndefined();

    const stopped = [
      user("prompt"),
      tool({ id: "read-1", ...A }),
      tool({ id: "read-2", ...A }),
      tool({ id: "read-3", ...A }),
      tool({
        id: "tests",
        toolName: "bash",
        status: "interrupted",
        isPartial: true,
        isLastPartOfMessage: true,
        ...A,
      }),
    ];
    // "tests" shows through the fold (it holds the control that continues the turn).
    expect(windowRows(stopped).indices).toEqual([0, 1, 4]);
  });

  test("translates window indices to the transcript and back", () => {
    const messages = [
      user("prompt-1"),
      tool({ id: "read-1", ...A }),
      tool({ id: "read-2", ...A }),
      tool({ id: "read-3", ...A }),
      assistant("reply-1", A),
      user("prompt-2"),
    ];
    const { rows } = windowRows(messages);
    // Window rows: prompt-1, read-1 (the work line), read-3, reply-1, prompt-2.
    expect([0, 1, 2, 3, 4].map(rows.toTranscriptIndex)).toEqual([0, 1, 3, 4, 5]);
    // One past the last window row is one past the last transcript row.
    expect(rows.toTranscriptIndex(5)).toBe(messages.length);
    // A folded step is reached through the row its work line renders at.
    expect([0, 1, 2, 3, 4, 5].map(rows.toWindowIndex)).toEqual([0, 1, 1, 2, 3, 4]);
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
        title: "Task wait failed",
        activeTitle: "Task wait failed",
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
      summary: { title: "Task wait failed", tone: "danger" },
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

describe("routine tool runs", () => {
  function routine(messages: DisplayedMessage[], isTurnActive = false) {
    return computeOperationalBundleInfos(messages, { isTurnActive });
  }

  // A parallel step: a command waiting for sandbox approval, another routine call, then an
  // edit. The edit makes the run no longer the tail, but the approval card lives in the
  // command's row, so the run must stay open until that call finishes.
  test("keeps a run open while one of its calls still needs the user", () => {
    const waiting = tool({ id: "bash-approval", toolName: "bash", status: "executing" });
    const read = tool({ id: "read-a" });
    const edit = tool({ id: "edit", toolName: "file_edit_replace_string" });

    expect(routine([waiting, read, edit], true)[0]).toMatchObject({
      key: "routine:bash-approval",
      defaultExpanded: true,
    });
    // Once the call finishes, the run folds: it is not the tail.
    expect(
      routine([{ ...waiting, status: "completed" }, read, edit], true)[0]?.defaultExpanded
    ).toBe(false);

    // The row a stopped turn ended on carries the interrupted divider: its run stays open too.
    const stopped = tool({
      id: "read-stopped",
      status: "interrupted",
      isPartial: true,
      isLastPartOfMessage: true,
    });
    expect(routine([read, stopped])[0]?.defaultExpanded).toBe(true);

    // A run of task polls keeps its own quiet row while a poll waits.
    const poll = (id: string, status: "completed" | "executing") =>
      tool({ id, toolName: "task_await", status });
    expect(
      routine([poll("poll-1", "completed"), poll("poll-2", "executing"), edit], true)[0]
        ?.defaultExpanded
    ).toBe(false);
  });

  test("folds routine calls with interleaved reasoning but leaves trailing reasoning out", () => {
    const read = tool({ id: "read-a", toolName: "file_read" });
    const between = reasoning({ id: "think-between" });
    const shell = tool({ id: "bash-a", toolName: "bash" });
    const trailing = reasoning({ id: "think-trailing" });
    const answer = assistant("answer-a");

    const infos = routine([read, between, shell, trailing, answer]);

    expect(infos[0]).toMatchObject({
      key: "routine:read-a",
      position: "head",
      defaultExpanded: false,
      summary: { title: "Read 1 file, ran 1 command", details: "" },
    });
    expect(infos[1]).toMatchObject({ key: "routine:read-a", position: "member" });
    expect(infos[2]).toMatchObject({ key: "routine:read-a", position: "member" });
    expect(infos[3]).toBeUndefined();
    expect(infos[4]).toBeUndefined();
  });

  test("keeps a lone routine call and rows the user must review as standalone cards", () => {
    const lone = routine([tool({ toolName: "file_read" }), assistant("after-lone")]);
    expect(lone[0]).toBeUndefined();

    const read = tool({ id: "read-b", toolName: "file_read" });
    const edit = tool({ id: "edit-b", toolName: "file_edit_replace_string" });
    const shellA = tool({ id: "bash-b1", toolName: "bash" });
    const shellB = tool({ id: "bash-b2", toolName: "bash" });
    const question = tool({ id: "ask-b", toolName: "ask_user_question" });

    const infos = routine([read, edit, shellA, shellB, question]);

    // The edit splits the run: the read alone is not worth a summary row.
    expect(infos[0]).toBeUndefined();
    expect(infos[1]).toBeUndefined();
    expect(infos[2]).toMatchObject({ key: "routine:bash-b1", position: "head" });
    expect(infos[3]).toMatchObject({ key: "routine:bash-b1", position: "member" });
    expect(infos[4]).toBeUndefined();
  });

  test("leaves background spawns and output polls to their own rows", () => {
    const spawn = tool({ id: "spawn-c", toolName: "bash", args: { run_in_background: true } });
    const wait = tool({ id: "await-c", toolName: "task_await" });
    // The spawn is not routine, so the single wait after it is not worth a summary row either.
    expect(routine([spawn, wait])).toEqual([undefined, undefined]);

    // A foreground command sent to the background mid-run is only marked in its result.
    const migrated = tool({
      id: "migrated-c",
      toolName: "bash",
      result: { success: true, backgroundProcessId: "proc-1" },
    });
    const read = tool({ id: "read-c", toolName: "file_read" });
    expect(routine([migrated, read])).toEqual([undefined, undefined]);

    // A script that spawned a background process is not routine either.
    const spawningScript = tool({
      id: "code-spawn",
      toolName: "code_execution",
      nestedCalls: [
        {
          toolCallId: "n-spawn",
          toolName: "bash",
          input: { run_in_background: true },
          state: "output-available",
        },
      ],
    });
    expect(routine([spawningScript, read])).toEqual([undefined, undefined]);

    // Consecutive bash_output polls keep their dedicated first/last collapse.
    const polls = ["poll-1", "poll-2", "poll-3"].map((id) => tool({ id, toolName: "bash_output" }));
    expect(routine(polls)).toEqual([undefined, undefined, undefined]);
  });

  test("treats code execution as routine only when everything it ran was routine", () => {
    const readOnlyRun = tool({
      id: "code-read",
      toolName: "code_execution",
      nestedCalls: [
        { toolCallId: "n1", toolName: "file_read", input: {}, state: "output-available" },
      ],
    });
    const plainRun = tool({ id: "code-plain", toolName: "code_execution" });
    const editingRun = tool({
      id: "code-edit",
      toolName: "code_execution",
      nestedCalls: [
        {
          toolCallId: "n2",
          toolName: "file_edit_insert",
          input: {},
          state: "output-available",
        },
      ],
    });
    const attachingRun = tool({
      id: "code-attach",
      toolName: "code_execution",
      result: {
        success: true,
        attachments: [{ type: "media", data: "x", mediaType: "image/png" }],
      },
    });

    const infos = routine([readOnlyRun, plainRun, editingRun, attachingRun, plainRun]);

    expect(infos[0]).toMatchObject({
      key: "routine:code-read",
      summary: { title: "Ran 2 scripts" },
    });
    expect(infos[1]).toMatchObject({ position: "member" });
    expect(infos[2]).toBeUndefined();
    expect(infos[3]).toBeUndefined();
    expect(infos[4]).toBeUndefined();
  });

  test("keeps the live run open until the agent moves on or the turn ends", () => {
    const first = tool({ id: "read-live-1", toolName: "file_read" });
    const second = tool({ id: "read-live-2", toolName: "file_read" });
    const thinking = reasoning({ id: "think-live", isStreaming: true });

    // Settled calls followed only by fresh reasoning: still the run the agent is working in.
    expect(routine([first, second, thinking], true)[0]).toMatchObject({
      state: "settled",
      defaultExpanded: true,
    });
    // Text after the run means the agent moved on, so the run folds even mid-turn.
    expect(routine([first, second, assistant("moved-on")], true)[0]).toMatchObject({
      defaultExpanded: false,
    });
    expect(routine([first, second, thinking], false)[0]).toMatchObject({
      defaultExpanded: false,
    });
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

  test("phrases mixed runs as verb clauses, merging shared verbs and folding reasoning in", () => {
    const summary = summarizeOperationalBundle([
      reasoning({ id: "think-1" }),
      tool({ id: "test-1", toolName: "bash", args: { script: "make test" } }),
      tool({ id: "read-1", toolName: "file_read" }),
      tool({ id: "code-1", toolName: "code_execution" }),
      tool({ id: "edit-1", toolName: "file_edit_replace_string" }),
    ]);

    expect(summary.title).toBe("Ran 1 command and 1 script, read 1 file, edited 1 file");
    expect(summary.details).toBe("");
  });

  test("calls a run of mixed read-only lookups exploration, but keeps one kind's own verb", () => {
    const explored = summarizeOperationalBundle([
      tool({ id: "read-1", toolName: "file_read" }),
      tool({ id: "read-2", toolName: "file_read" }),
      tool({ id: "search-1", toolName: "web_search", result: [{ title: "one" }] }),
    ]);
    expect(explored.title).toBe("Explored 2 files, 1 search");

    const searches = summarizeOperationalBundle([
      tool({ id: "search-2", toolName: "web_search", result: [{ title: "two" }] }),
      tool({ id: "search-3", toolName: "web_search", result: [{ title: "three" }] }),
    ]);
    expect(searches.title).toBe("Ran 2 searches");
  });

  test("reads as a thought when the bundle only reasoned", () => {
    expect(summarizeOperationalBundle([reasoning({ id: "think-only" })]).title).toBe("Thought");
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

    expect(summary.title).toBe("Ran 2 searches");
  });

  test("all-miss completed search bundle says it found nothing", () => {
    const allMiss = summarizeOperationalBundle([
      tool({ id: "search-1", toolName: "web_search", status: "completed", result: [] }),
      tool({
        id: "search-2",
        toolName: "web_search",
        status: "completed",
        result: { type: "json", value: { sources: [] } },
      }),
    ]);
    expect(allMiss.title).toBe("Ran 2 searches, no results");
  });

  test("failed searches report the failure, not missing results", () => {
    const failedSearch = summarizeOperationalBundle([
      tool({
        id: "search-1",
        toolName: "web_search",
        status: "failed",
        result: { error: "provider unavailable" },
      }),
    ]);
    expect(failedSearch.title).toBe("Ran 1 search");
    expect(failedSearch.details).toBe("1 failed");
  });
});
