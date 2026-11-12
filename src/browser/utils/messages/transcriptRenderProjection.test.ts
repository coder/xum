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

  test("folds everything but the reply behind one line", () => {
    const infos = work([
      user("prompt"),
      reasoning({ id: "think", ...TURN }),
      assistant("narration", TURN),
      tool({ id: "read", ...TURN }),
      tool({ id: "edit", toolName: "file_edit_replace_string", ...TURN }),
      assistant("reply", TURN),
    ]);

    expect(infos[0]).toBeUndefined();
    for (const index of [1, 2, 3, 4]) {
      expect(infos[index]).toMatchObject({
        key: "work:think",
        headIndex: 1,
        role: "work",
        visibleWhenFolded: false,
        state: "settled",
        kind: "work",
      });
    }
    expect(infos[5]).toMatchObject({
      key: "work:think",
      role: "answer",
      visibleWhenFolded: true,
    });
  });

  test("keeps the reply in view when bookkeeping follows it", () => {
    const infos = work([
      tool({ id: "read", ...TURN }),
      assistant("reply", TURN),
      tool({ id: "todo", toolName: "todo_write", ...TURN }),
    ]);

    expect(infos[1]).toMatchObject({ role: "answer" });
    expect(infos[2]).toMatchObject({
      key: "work:read",
      role: "work",
      visibleWhenFolded: false,
    });
  });

  test("keeps one line, and the last narration in view, when the turn worked on after it", () => {
    // Interrupted while running the tests. The work after "Now running the tests." is behind the
    // same line as the work before it: one turn, one line. The narration is the last thing the
    // agent said, so it stays in view.
    const infos = work([
      user("prompt"),
      tool({ id: "read", ...TURN }),
      assistant("now-running-the-tests", TURN),
      tool({ id: "tests", toolName: "bash", status: "interrupted", ...TURN }),
      tool({ id: "todo", toolName: "todo_write", ...TURN }),
    ]);

    expect(infos.slice(1).map((info) => info?.key)).toEqual(Array<string>(4).fill("work:read"));
    expect(infos.slice(1).map((info) => info?.role)).toEqual(["work", "answer", "work", "work"]);
    expect(infos[3]).toMatchObject({ visibleWhenFolded: false });

    // While the turn runs, the same line names the running call.
    const live = work(
      [
        user("prompt"),
        tool({ id: "read", ...TURN }),
        assistant("now-running-the-tests", TURN),
        tool({ id: "tests", toolName: "bash", status: "executing", ...TURN }),
      ],
      true
    );
    expect(live[3]).toMatchObject({
      key: "work:read",
      state: "live",
      liveStep: "Running a command",
    });
  });

  test("merges the messages of one turn until one of them replies", () => {
    // Interrupted mid-work, then continued: two assistant messages, one piece of work.
    const infos = work([
      user("prompt"),
      tool({ id: "read-a", historyId: "history-a" }),
      assistant("narration-a", { historyId: "history-a" }),
      tool({ id: "tests-a", toolName: "bash", status: "interrupted", historyId: "history-a" }),
      tool({ id: "read-b", historyId: "history-b" }),
      assistant("reply-b", { historyId: "history-b" }),
    ]);

    expect(infos.slice(1).map((info) => info?.key)).toEqual(Array<string>(5).fill("work:read-a"));
    // The earlier narration is not the reply: it folds with the work.
    expect(infos.slice(1).map((info) => info?.role)).toEqual([
      "work",
      "work",
      "work",
      "work",
      "answer",
    ]);
  });

  test("folds a machine prompt with the work it starts, after the reply before it", () => {
    const infos = work([
      user("prompt"),
      tool({ id: "read-a", historyId: "history-a" }),
      assistant("reply-a", { historyId: "history-a" }),
      wake("wake"),
      tool({ id: "read-b", historyId: "history-b" }),
      assistant("reply-b", { historyId: "history-b" }),
    ]);

    expect(infos[2]).toMatchObject({ key: "work:read-a", role: "answer" });
    // The wake-up heads the next stretch: opening that line shows what woke the agent.
    expect(infos[3]).toMatchObject({
      key: "work:wake",
      headIndex: 3,
      role: "work",
      visibleWhenFolded: false,
    });
    expect(infos[4]).toMatchObject({ key: "work:wake", role: "work" });
    expect(infos[5]).toMatchObject({ key: "work:wake", role: "answer" });

    // A prompt the user typed is never folded, whatever it says.
    const typed = { ...wake("typed"), isSynthetic: false };
    const withTyped = work([tool({ id: "read", ...TURN }), typed, tool({ id: "next", ...TURN })]);
    expect(withTyped[1]).toBeUndefined();
    expect(withTyped[2]).toMatchObject({ key: "work:next" });
  });

  test("keeps a nudge and the bookkeeping it asked for behind the reply's line", () => {
    const messages = [
      user("prompt"),
      tool({ id: "read-a", historyId: "history-a" }),
      assistant("reply-a", { historyId: "history-a" }),
      wake("nudge"),
      tool({ id: "todo", toolName: "todo_write", historyId: "history-b" }),
    ];

    // Nothing after the reply said or did anything: no second line.
    const settled = work(messages);
    expect(settled.slice(1).map((info) => info?.key)).toEqual(Array<string>(4).fill("work:read-a"));
    expect(settled[2]).toMatchObject({ role: "answer" });
    expect(settled[4]).toMatchObject({ role: "work", visibleWhenFolded: false });

    // While the turn runs the agent is acting on the nudge: that is its own, live, stretch,
    // and the finished line above does not appear to restart.
    const live = work(messages, true);
    expect(live[1]).toMatchObject({ key: "work:read-a", state: "settled" });
    expect(live[3]).toMatchObject({ key: "work:nudge", state: "live" });
    expect(live[4]).toMatchObject({ key: "work:nudge", liveStep: "Using todo_write" });
  });

  test("leaves a machine prompt the agent has not acted on as its own row", () => {
    expect(work([user("prompt"), wake("wake")])).toEqual([undefined, undefined]);
    // With only a reply after it there is still no work to fold.
    const replied = work([user("prompt"), wake("wake"), assistant("reply", TURN)]);
    expect(replied).toEqual([undefined, undefined, undefined]);
  });

  test("counts the files the folded work edited, once each and only when the edit landed", () => {
    const edit = (id: string, path: string, overrides: Partial<ReturnType<typeof tool>> = {}) =>
      tool({ id, toolName: "file_edit_replace_string", args: { path }, ...TURN, ...overrides });
    const infos = work([
      edit("edit-1", "src/a.ts"),
      edit("edit-2", "src/a.ts"),
      edit("edit-3", "src/b.ts", { toolName: "file_edit_insert" }),
      edit("edit-failed", "src/c.ts", { status: "failed" }),
      edit("edit-refused", "src/d.ts", { result: { success: false, error: "no match" } }),
      // A script's edits count too.
      tool({
        id: "script",
        toolName: "code_execution",
        ...TURN,
        nestedCalls: [
          {
            toolCallId: "nested-edit",
            toolName: "file_edit_insert",
            input: { path: "src/e.ts" },
            output: { success: true },
            state: "output-available",
          },
        ],
      }),
      tool({ id: "read", args: { path: "src/f.ts" }, ...TURN }),
      assistant("reply", TURN),
    ]);

    expect(infos[0]?.editedFileCount).toBe(3);
    expect(
      work([tool({ id: "read", ...TURN }), assistant("reply", TURN)])[0]?.editedFileCount
    ).toBe(0);
  });

  test("gives a reply with no work behind it no line, and a turn that only reasoned its own name", () => {
    expect(work([user("prompt"), assistant("reply", TURN)])).toEqual([undefined, undefined]);

    const thought = work([reasoning({ id: "think", ...TURN }), assistant("reply", TURN)]);
    expect(thought[0]).toMatchObject({ role: "work", kind: "thought" });

    // Narration that folds is work, not thought.
    const narrated = work([
      assistant("narration", TURN),
      reasoning({ id: "think", ...TURN }),
      assistant("reply", TURN),
    ]);
    expect(narrated[0]).toMatchObject({ role: "work", kind: "work" });
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

    expect(infos[0]).toMatchObject({ key: "work:read-a", role: "work" });
    expect(infos[1]).toBeUndefined();
    expect(infos[2]).toMatchObject({
      key: "work:read-b",
      headIndex: 2,
      role: "work",
    });
    expect(infos[3]).toMatchObject({ key: "work:read-b", role: "answer" });
    expect(infos[4]).toBeUndefined();
    expect(infos[5]).toBeUndefined();
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

    expect(infos[0]).toMatchObject({ key: "work:read-a", role: "work" });
    expect(infos[1]).toBeUndefined();
    expect(infos[2]).toMatchObject({ key: "work:read-b", role: "work" });
    expect(infos[3]).toBeUndefined();
    // The reply after the last view has no work behind it, so it needs no line.
    expect(infos[4]).toBeUndefined();
  });

  test("gives a second message its own stretch and reply when no prompt separates them", () => {
    const infos = work([
      tool({ id: "read-a", historyId: "history-a" }),
      assistant("reply-a", { historyId: "history-a" }),
      tool({ id: "read-b", historyId: "history-b" }),
      assistant("reply-b", { historyId: "history-b" }),
    ]);

    expect(infos[1]).toMatchObject({ key: "work:read-a", role: "answer" });
    expect(infos[3]).toMatchObject({ key: "work:read-b", role: "answer" });
  });

  test("names a live turn's latest step on its line and mounts no row for it", () => {
    const narration = assistant("narration", TURN);
    const first = tool({ id: "read-1", args: { path: "src/auth/session.ts" }, ...TURN });
    const latest = tool({
      id: "tests",
      toolName: "bash",
      status: "executing",
      args: { script: "bun test", model_intent: "Running the unit tests" },
      ...TURN,
    });

    // Nothing shows under the line but the narration: a step that rendered in under it was gone
    // again when the next one started.
    const working = work([user("prompt"), narration, first, latest], true);
    expect(working[1]).toMatchObject({ state: "live", role: "answer" });
    expect(working.slice(2).map((info) => info?.visibleWhenFolded)).toEqual([false, false]);
    expect(working[2]).toMatchObject({ state: "live", liveStep: "Running the unit tests" });

    // The line follows the turn step by step.
    const stepOf = (...steps: DisplayedMessage[]) =>
      work([user("prompt"), ...steps], true)[1]?.liveStep;
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

    // A turn that has only reasoned already reads "Thinking": its line needs no step.
    expect(
      work([user("prompt"), reasoning({ isStreaming: true, ...TURN })], true)[1]
    ).toMatchObject({
      kind: "thought",
      liveStep: undefined,
    });

    // Once the agent writes, the narration is the latest thing and the line names no step.
    const writing = work(
      [
        user("prompt"),
        narration,
        first,
        latest,
        assistant("reply", { ...TURN, isStreaming: true }),
      ],
      true
    );
    expect(writing[1]).toMatchObject({ role: "work", visibleWhenFolded: false });
    expect(writing[4]).toMatchObject({ state: "live", role: "answer", liveStep: undefined });

    // The same rows are settled once the turn ends, and an earlier turn is never live.
    const settled = work([user("prompt"), narration, first, tool({ id: "done", ...TURN })], false);
    expect(settled[3]).toMatchObject({ state: "settled", liveStep: undefined });
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
      liveStep: "Running a command",
    });
  });

  // The row the transcript ends on when its turn was interrupted carries the divider that
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

    const stoppedWhileThinking = work([
      user("prompt"),
      reasoning({ id: "think", isPartial: true, isLastPartOfMessage: true, ...TURN }),
    ]);
    expect(stoppedWhileThinking[1]).toMatchObject({ kind: "thought", visibleWhenFolded: true });

    const wentOn = work([
      user("prompt"),
      reasoning({ id: "think", isPartial: true, isLastPartOfMessage: true, ...TURN }),
      user("next-prompt"),
    ]);
    expect(wentOn[1]).toMatchObject({ kind: "thought", visibleWhenFolded: false });
  });

  test("times a stretch from the prompt to its latest timestamp, or not at all", () => {
    const prompt = user("prompt", 1_000);
    const timed = work([
      prompt,
      tool({ id: "read", timestamp: 5_000, ...TURN }),
      assistant("reply", { ...TURN, timestamp: 135_000 }),
      // A row without its own timestamp carries its message's start: it must not end the clock.
      tool({ id: "todo", toolName: "todo_write", timestamp: 5_000, ...TURN }),
    ]);
    expect(timed[1]).toMatchObject({ startedAtMs: 1_000, durationMs: 134_000 });

    // A machine prompt can start the clock (the wake-up that began the work) and never ends
    // it: a report is shown where the agent was, which can be before older rows.
    const woken = work([
      prompt,
      assistant("reply-a", { historyId: "history-a", timestamp: 2_000 }),
      wake("wake", 60_000),
      tool({ id: "read", timestamp: 61_000, ...TURN }),
      wake("late-report", 900_000),
      assistant("reply-b", { ...TURN, timestamp: 70_000 }),
    ]);
    expect(woken[2]).toMatchObject({ key: "work:wake", startedAtMs: 60_000, durationMs: 10_000 });

    const untimed = work([user("prompt"), tool({ id: "read", ...TURN }), assistant("reply", TURN)]);
    expect(untimed[1]?.durationMs).toBeUndefined();

    // A live stretch has a start for the running clock and no duration yet.
    const live = work([prompt, tool({ id: "read", timestamp: 5_000, ...TURN })], true);
    expect(live[1]).toMatchObject({ startedAtMs: 1_000 });
    expect(live[1]?.durationMs).toBeUndefined();
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

  test("leaves out the steps folded behind a finished turn's work line", () => {
    const messages = [
      user("prompt-1"),
      tool({ id: "read-1", ...A }),
      tool({ id: "read-2", ...A }),
      tool({ id: "read-3", ...A }),
      assistant("reply-1", A),
      user("prompt-2"),
      tool({ id: "read-4", ...B }),
      tool({ id: "read-5", ...B }),
      tool({ id: "read-6", ...B }),
    ];
    const { indices, rows } = windowRows(messages);

    // The first row of a stretch carries the work line, and the reply shows. The second
    // stretch has no reply: its last row counts, so the transcript's newest row always does.
    expect(indices).toEqual([0, 1, 4, 5, 6, 8]);
    expect(rows.rows.map((row) => row.id)).toEqual([
      "prompt-1",
      "read-1",
      "reply-1",
      "prompt-2",
      "read-4",
      "read-6",
    ]);
  });

  test("counts every row of the live turn, and a settled row that still needs the user", () => {
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
    // "tests" shows through the fold (it holds the interrupted divider); the reads are folded.
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
    // Window rows: prompt-1, read-1 (the work line), reply-1, prompt-2.
    expect([0, 1, 2, 3].map(rows.toTranscriptIndex)).toEqual([0, 1, 4, 5]);
    // One past the last window row is one past the last transcript row.
    expect(rows.toTranscriptIndex(4)).toBe(messages.length);
    // A folded step is reached through the row its work line renders at.
    expect([0, 1, 2, 3, 4, 5].map(rows.toWindowIndex)).toEqual([0, 1, 1, 1, 2, 3]);
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

  // Each work line opens alone. A run across two of them would put its summary row behind the
  // first line and leave the second with members that nothing visible can open. The projection
  // only ends a stretch after a reply, which also ends a run, so the lines are given by hand:
  // the rule is what keeps the two groupings paired if that ever changes.
  test("stops a run where compact density's work line changes", () => {
    const messages = [
      tool({ id: "read-a1", historyId: "history-a" }),
      tool({ id: "read-a2", historyId: "history-a" }),
      tool({ id: "read-b1", historyId: "history-b" }),
      tool({ id: "read-b2", historyId: "history-b" }),
      assistant("reply", { historyId: "history-b" }),
    ];
    const line = (key: string, headIndex: number): WorkBundleInfo => ({
      key,
      headIndex,
      role: "work",
      visibleWhenFolded: false,
      state: "settled",
      kind: "work",
      editedFileCount: 0,
    });
    const workBundleInfos = [line("a", 0), line("a", 0), line("b", 2), line("b", 2), undefined];
    const infos = computeOperationalBundleInfos(messages, { isTurnActive: false, workBundleInfos });

    expect(infos.slice(0, 4).map((info) => [info?.key, info?.position])).toEqual([
      ["routine:read-a1", "head"],
      ["routine:read-a1", "member"],
      ["routine:read-b1", "head"],
      ["routine:read-b1", "member"],
    ]);

    // Detailed density has no work lines, and the four reads are one run.
    expect(routine(messages).map((info) => info?.key)).toEqual([
      "routine:read-a1",
      "routine:read-a1",
      "routine:read-a1",
      "routine:read-a1",
      undefined,
    ]);

    // One read on each side of the boundary is no run on either side: both stay plain rows.
    const lone = [messages[0], messages[2], messages[4]];
    expect(
      computeOperationalBundleInfos(lone, {
        isTurnActive: false,
        workBundleInfos: [line("a", 0), line("b", 1), undefined],
      })
    ).toEqual([undefined, undefined, undefined]);
  });

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
