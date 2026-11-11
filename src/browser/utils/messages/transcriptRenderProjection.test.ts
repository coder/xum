import { describe, expect, test } from "bun:test";
import { TRANSCRIPT_REVEAL_STEP_CHARS } from "@/common/constants/ui";
import type { DisplayedMessage } from "@/common/types/message";
import {
  computeOperationalBundleInfos,
  computeWorkBundleInfos,
  estimateTranscriptRowWeight,
  summarizeOperationalBundle,
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

function user(id: string, timestamp?: number): DisplayedMessage {
  return {
    type: "user",
    id,
    historyId: `history-${id}`,
    content: "hello",
    historySequence: 1,
    timestamp,
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

  test("does not pass off narration as the reply when the turn worked on after it", () => {
    // Interrupted while running the tests: "Now running the tests." announced work, it did not
    // report on it. The work after it gets its own line, below the narration.
    const infos = work([
      user("prompt"),
      tool({ id: "read", ...TURN }),
      assistant("now-running-the-tests", TURN),
      tool({ id: "tests", toolName: "bash", status: "interrupted", ...TURN }),
      tool({ id: "todo", toolName: "todo_write", ...TURN }),
    ]);

    expect(infos[1]).toMatchObject({ key: "work:read", role: "work" });
    expect(infos[2]).toMatchObject({ key: "work:read", role: "answer" });
    expect(infos[3]).toMatchObject({ key: "work:tests", headIndex: 3, role: "work" });
    expect(infos[4]).toMatchObject({ key: "work:tests", role: "work", visibleWhenFolded: false });

    // While the turn runs it is still one stretch, with the running call showing through.
    const live = work(
      [
        user("prompt"),
        tool({ id: "read", ...TURN }),
        assistant("now-running-the-tests", TURN),
        tool({ id: "tests", toolName: "bash", status: "executing", ...TURN }),
      ],
      true
    );
    expect(live[3]).toMatchObject({ key: "work:read", state: "live", visibleWhenFolded: true });
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

  test("shows a live turn's latest step through the fold until the agent starts writing", () => {
    const narration = assistant("narration", TURN);
    const first = tool({ id: "read-1", ...TURN });
    const latest = tool({ id: "read-2", ...TURN });

    const working = work([user("prompt"), narration, first, latest], true);
    expect(working[1]).toMatchObject({ state: "live", role: "answer" });
    expect(working[2]).toMatchObject({
      state: "live",
      visibleWhenFolded: false,
    });
    expect(working[3]).toMatchObject({
      state: "live",
      visibleWhenFolded: true,
    });

    // New narration is now the latest thing: the step before it folds, and so does the old narration.
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
    expect(writing[1]).toMatchObject({
      role: "work",
      visibleWhenFolded: false,
    });
    expect(writing[3]).toMatchObject({ visibleWhenFolded: false });
    expect(writing[4]).toMatchObject({ state: "live", role: "answer" });

    // The same rows are settled once the turn ends, and an earlier turn is never live.
    expect(work([user("prompt"), narration, first, latest], false)[3]).toMatchObject({
      state: "settled",
      visibleWhenFolded: false,
    });
    expect(work([first, assistant("reply", TURN), user("next")], true)[0]).toMatchObject({
      state: "settled",
    });
  });

  test("shows every call that is still running, whether or not the host reports the turn", () => {
    const waiting = tool({
      id: "approval",
      toolName: "bash",
      status: "pending",
      ...TURN,
    });
    const done = tool({ id: "read", ...TURN });
    const running = tool({
      id: "tests",
      toolName: "bash",
      status: "executing",
      ...TURN,
    });

    const infos = work([waiting, done, running], false);

    expect(infos[0]).toMatchObject({ state: "live", visibleWhenFolded: true });
    expect(infos[1]).toMatchObject({ visibleWhenFolded: false });
    expect(infos[2]).toMatchObject({ visibleWhenFolded: true });
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

    const untimed = work([user("prompt"), tool({ id: "read", ...TURN }), assistant("reply", TURN)]);
    expect(untimed[1]?.durationMs).toBeUndefined();

    // A live stretch has a start for the running clock and no duration yet.
    const live = work([prompt, tool({ id: "read", timestamp: 5_000, ...TURN })], true);
    expect(live[1]).toMatchObject({ startedAtMs: 1_000 });
    expect(live[1]?.durationMs).toBeUndefined();
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
