// Characterization tests for TaskService.acknowledgeAgentReports, written before the method is split
// into steps. The method marks an owner's pending sub-agent report wakes delivered when the owner's
// history proves that a completed answer saw the report: through the request that included the
// injected report row, or through a task/task_await receipt. Each case feeds the method exact history
// rows and asserts the returned ids, the ids left pending and the turn records it read. The trace
// cases pin the order of every collaborator call, so a split cannot add, drop or reorder one.
// taskService.test.ts drives the same method through real history and the drain.
/* eslint-disable @typescript-eslint/await-thenable -- bun:test async matchers return thenables the rule cannot see */
import assert from "node:assert";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createMuxMessage, type MuxMessage, type MuxMetadata } from "@/common/types/message";
import { Err, Ok } from "@/common/types/result";
import { formatSubagentReportEnvelope } from "@/common/utils/subagentReportEnvelope";
import type { Config } from "@/node/config";
import {
  TaskHandleStore,
  type WorkspaceTurnTaskHandleRecord,
} from "@/node/services/taskHandleStore";
import {
  TerminalAttentionStore,
  type TerminalAttentionOutcome,
  type TerminalAttentionSourceKind,
} from "@/node/services/terminalAttentionStore";
import {
  createTestConfig,
  projectWorkspace,
  saveWorkspaces,
  testTaskSettings,
  workspaceTurnRecord,
} from "@/node/services/taskService.testHarness";
import {
  createTaskServiceHarness,
  createTaskServiceTestRoot,
  removeTaskServiceTestRoot,
} from "@/node/services/taskService.shared.testHarness";

const OWNER = "owner-ws";
/** The owner's parent: the second owner the turn-record lookup tries. */
const ROOT = "root-ws";
const CHILD = "child-a";
const REPORT = "Child findings.";
const FINAL = "final-message";
const HANDLE = "wst_turn";

/** One pending wake. Unset fields: an agent_task wake for CHILD, completed, with no generation. */
interface Wake {
  sourceId?: string;
  sourceKind?: TerminalAttentionSourceKind;
  generationId?: string;
  terminalOutcome?: TerminalAttentionOutcome;
}

type StoredRecords = Array<[owner: string, WorkspaceTurnTaskHandleRecord]>;

/** One wake, the history rows the method reads, and the expected outcome. */
interface Case {
  rows: MuxMessage[];
  wake?: Wake;
  records?: StoredRecords;
  /** The owners whose turn record the method read, in order (default none). */
  lookups?: string[];
  consumed: boolean;
}

/** The synthetic user row that injected a child's completed report into the owner's history. */
function reportRow(
  historySequence: number | undefined,
  metadata: MuxMetadata = {},
  taskId = CHILD
): MuxMessage {
  const envelope = formatSubagentReportEnvelope({
    taskId,
    agentType: "explore",
    title: "Result",
    status: "completed",
    reportMarkdown: REPORT,
  });
  return createMuxMessage("report", "user", envelope, {
    synthetic: true,
    historySequence,
    ...metadata,
  });
}

/** A completed owner answer (stop, not partial, not a compaction summary), one task_await per result. */
function answer(
  metadata: MuxMetadata = {},
  results: object[] = [],
  role: "user" | "assistant" = "assistant"
): MuxMessage {
  const parts: MuxMessage["parts"] = results.map((result, index) => ({
    type: "dynamic-tool",
    toolCallId: `await-${index}`,
    toolName: "task_await",
    input: {},
    state: "output-available",
    output: { results: [result] },
  }));
  const fields = { finishReason: "stop", agentId: "exec", ...metadata };
  return createMuxMessage("answer", role, "Done.", fields, parts);
}

/** A first assignment's receipt: the child id and its report. */
const initialReceipt = { status: "completed", taskId: CHILD, reportMarkdown: REPORT };
/** A stable-child await of a continuation: the child id plus the final message id. */
const childReceipt = { ...initialReceipt, messageId: FINAL };
/** A workspace-turn handle's receipt for CHILD. */
const handleReceipt = { ...childReceipt, taskId: HANDLE, workspaceId: CHILD };
/** A completed turn record of a handle, holding the final message and report that receipts name. */
const record = (workspaceId = CHILD, handleId = HANDLE, overrides = {}) =>
  workspaceTurnRecord(OWNER, workspaceId, handleId, "completed", {
    messageId: FINAL,
    reportMarkdown: REPORT,
    ...overrides,
  });
const TURN = record();
const generationOf = (turn: WorkspaceTurnTaskHandleRecord) =>
  [turn.handleId, turn.status, turn.updatedAt].join(":");

/** Wraps fn so that each call first appends label(...args) to the trace. */
function traced<A extends unknown[], R>(
  trace: string[],
  fn: (...args: A) => R,
  label: (...args: A) => string
): (...args: A) => R {
  return (...args) => {
    trace.push(label(...args));
    return fn(...args);
  };
}

describe("TaskService.acknowledgeAgentReports", () => {
  let rootDir: string;
  // Every Config a test built; afterEach settles its queued migration write before the root goes.
  let configs: Config[];
  beforeEach(async () => {
    rootDir = await createTaskServiceTestRoot();
    configs = [];
  });
  afterEach(async () => {
    mock.restore();
    // allSettled: a test that failed early must still not leave a config write running.
    await Promise.allSettled(configs.splice(0).map(settleConfigWrites));
    await removeTaskServiceTestRoot(rootDir);
  });

  /**
   * The method starts no background work, but a config read of a file that still needs a load-time
   * migration queues a one-shot write. This read queues it and the edit queued behind it returns once
   * it landed, so the method's own config read starts no write that would outlive the test.
   */
  async function settleConfigWrites(config: Config): Promise<void> {
    config.loadConfigOrDefault();
    await config.editConfig((cfg) => cfg);
  }

  /**
   * OWNER (a child of ROOT) with the given pending wakes, in this order, and turn records stored
   * under the given owners. The history read returns `rows` (or fails). Each collaborator call that
   * the method makes is appended to `trace`.
   */
  async function setup(rows: MuxMessage[] | "read fails", wakes: Wake[], records: StoredRecords) {
    const config = await createTestConfig(rootDir);
    configs.push(config);
    const projectPath = path.join(rootDir, "repo");
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", ROOT),
        projectWorkspace(projectPath, "owner", OWNER, { parentWorkspaceId: ROOT }),
      ],
      testTaskSettings()
    );
    const store = new TerminalAttentionStore(config);
    const ids: string[] = [];
    for (const [index, wake] of wakes.entries()) {
      const notification = await store.enqueueIfAbsent({
        ownerWorkspaceId: OWNER,
        sourceKind: wake.sourceKind ?? "agent_task",
        sourceId: wake.sourceId ?? CHILD,
        generationId: wake.generationId,
        terminalOutcome: wake.terminalOutcome,
        // listPending sorts by createdAt, so the wakes stay in this order.
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      });
      assert(notification, "each wake is new");
      ids.push(notification.id);
    }
    for (const [owner, turn] of records) {
      await new TaskHandleStore(config).upsertWorkspaceTurn({ ...turn, ownerWorkspaceId: owner });
    }
    await settleConfigWrites(config);

    const { historyService, taskService, terminalAttentionStore, workspaceTurnManager } =
      createTaskServiceHarness(config);
    // Bind the real methods before the spies replace them.
    const real = {
      listPending: terminalAttentionStore.listPending.bind(terminalAttentionStore),
      loadConfig: config.loadConfigOrDefault.bind(config),
      getRecord: workspaceTurnManager.getWorkspaceTurnRecord.bind(workspaceTurnManager),
      generation:
        workspaceTurnManager.workspaceTurnTerminalAttentionGenerationId.bind(workspaceTurnManager),
      markDelivered: terminalAttentionStore.markDelivered.bind(terminalAttentionStore),
    };
    const trace: string[] = [];
    const history = () => Promise.resolve(rows === "read fails" ? Err("read failed") : Ok(rows));
    spyOn(historyService, "getHistoryFromLatestBoundary").mockImplementation(
      traced(trace, history, () => "history")
    );
    spyOn(terminalAttentionStore, "listPending").mockImplementation(
      traced(trace, real.listPending, () => "pending")
    );
    spyOn(config, "loadConfigOrDefault").mockImplementation(
      traced(trace, real.loadConfig, () => "config")
    );
    spyOn(workspaceTurnManager, "getWorkspaceTurnRecord").mockImplementation(
      traced(trace, real.getRecord, (owner) => `record:${owner}`)
    );
    spyOn(workspaceTurnManager, "workspaceTurnTerminalAttentionGenerationId").mockImplementation(
      traced(trace, real.generation, () => "generation")
    );
    const deliver = spyOn(terminalAttentionStore, "markDelivered").mockImplementation(
      traced(trace, real.markDelivered, (_owner, id) => `delivered:${id}`)
    );
    const listPendingIds = async () => (await store.listPending(OWNER)).map((wake) => wake.id);
    return {
      ids,
      trace,
      deliver,
      listPendingIds,
      acknowledge: () => taskService.acknowledgeAgentReports(OWNER),
      /** The ids the method returned, in order, and the ids still pending afterwards. */
      run: async () => {
        const consumed = await taskService.acknowledgeAgentReports(OWNER);
        expect(consumed).toBeInstanceOf(Set);
        return { consumed: [...consumed], pending: await listPendingIds() };
      },
    };
  }

  function testCases(group: string, cases: Record<string, Case>): void {
    for (const [name, c] of Object.entries(cases)) {
      test(`${group}: ${name}`, async () => {
        const fixture = await setup(c.rows, [c.wake ?? {}], c.records ?? []);
        const [id] = fixture.ids;
        expect(await fixture.run()).toEqual(
          c.consumed ? { consumed: [id], pending: [] } : { consumed: [], pending: [id] }
        );
        expect(fixture.trace.filter((call) => call.startsWith("record:"))).toEqual(
          (c.lookups ?? []).map((owner) => `record:${owner}`)
        );
      });
    }
  }

  describe("early exits", () => {
    const covered = [reportRow(4), answer({ requestHistorySequence: 4 })];
    for (const [name, wakes] of [
      ["nothing is pending", []],
      [
        "only a workspace-turn wake is pending",
        [{ sourceKind: "workspace_turn", sourceId: HANDLE }],
      ],
    ] satisfies Array<[string, Wake[]]>) {
      test(`returns an empty set without reading history when ${name}`, async () => {
        const fixture = await setup(covered, wakes, []);
        expect(await fixture.run()).toEqual({ consumed: [], pending: fixture.ids });
        expect(fixture.trace).toEqual(["pending"]);
      });
    }

    test("returns an empty set and keeps the wake when the history read fails", async () => {
      const fixture = await setup("read fails", [{}], []);
      expect(await fixture.run()).toEqual({ consumed: [], pending: fixture.ids });
      expect(fixture.trace).toEqual(["pending", "history"]);
    });
  });

  // Each case changes one input of a completed answer, so exactly one term of the answer condition
  // decides. Each runs once per proof: a receipt in the answer, and the answer's request sequence
  // covering the report row.
  for (const proof of ["receipt", "request sequence"] as const) {
    const rows = (metadata: MuxMetadata = {}, role: "user" | "assistant" = "assistant") =>
      proof === "receipt"
        ? [answer(metadata, [initialReceipt], role)]
        : [reportRow(4), answer({ requestHistorySequence: 4, ...metadata }, [], role)];
    testCases(`answer terms (${proof})`, {
      "a completed answer consumes the report": { rows: rows(), consumed: true },
      "a partial answer": { rows: rows({ partial: true }), consumed: false },
      "an answer cut off by length": { rows: rows({ finishReason: "length" }), consumed: false },
      "a compaction summary": { rows: rows({ agentId: "compact" }), consumed: false },
      "a legacy compaction summary": { rows: rows({ mode: "compact" }), consumed: false },
      "a user row with answer metadata": { rows: rows({}, "user"), consumed: false },
    });
  }

  // Which report row marks where the report entered the history, and which answer covers it.
  const coveredBy = (sequence: number) => answer({ requestHistorySequence: sequence });
  const filePart = { type: "file" as const, mediaType: "image/png", url: "data:," };
  testCases("report position", {
    "an answer to a request before the report": {
      rows: [reportRow(4), coveredBy(3)],
      consumed: false,
    },
    "a report at sequence 0 with no answer": { rows: [reportRow(0)], consumed: false },
    "the highest request sequence of all answers counts": {
      rows: [reportRow(4), coveredBy(4), answer(), coveredBy(1)],
      consumed: true,
    },
    "the newest report row counts": {
      rows: [reportRow(2), reportRow(6), coveredBy(4)],
      consumed: false,
    },
    "a newer report row without a sequence": {
      rows: [reportRow(4), reportRow(undefined), coveredBy(4)],
      consumed: true,
    },
    "a report row with a file part before its text": {
      rows: [{ ...reportRow(4), parts: [filePart, ...reportRow(4).parts] }, coveredBy(4)],
      consumed: true,
    },
    "a report row that is not synthetic": {
      rows: [reportRow(4, { synthetic: false }), coveredBy(4)],
      consumed: false,
    },
    "an assistant row with the report text": {
      rows: [{ ...reportRow(4), role: "assistant" }, coveredBy(4)],
      consumed: false,
    },
  });

  // A wake without a generation is a first assignment: only an initial receipt proves it, and only
  // for a completed child. The covered request sequence proves any outcome.
  const failed: Wake = { terminalOutcome: "failed" };
  testCases("first assignment", {
    "only a continuation receipt": { rows: [answer({}, [childReceipt])], consumed: false },
    "a failed child's receipt": {
      rows: [answer({}, [initialReceipt])],
      wake: failed,
      consumed: false,
    },
    "a failed child's covered report row": {
      rows: [reportRow(4), coveredBy(4)],
      wake: failed,
      consumed: true,
    },
    "a covered report row next to a continuation receipt": {
      rows: [reportRow(4), answer({ requestHistorySequence: 4 }, [childReceipt])],
      consumed: true,
    },
  });

  // A wake with a generation is a continuation: the receipt must match the turn record that the
  // generation's handle names, looked up under the owner first, then under its ancestors.
  const continuation = (fields: {
    generationId?: string;
    records?: StoredRecords;
    receipt?: object;
    lookups?: string[];
    consumed?: boolean;
  }): Case => ({
    rows: [answer({}, [fields.receipt ?? handleReceipt])],
    wake: { generationId: fields.generationId ?? HANDLE },
    records: fields.records ?? [[OWNER, TURN]],
    lookups: fields.lookups ?? [OWNER],
    consumed: fields.consumed ?? false,
  });
  testCases("continuation", {
    "a handle receipt": continuation({ generationId: generationOf(TURN), consumed: true }),
    "a bare-handle generation": continuation({ consumed: true }),
    "a stable-child receipt": continuation({ receipt: childReceipt, consumed: true }),
    "a record under the owner's parent": continuation({
      records: [[ROOT, TURN]],
      lookups: [OWNER, ROOT],
      consumed: true,
    }),
    "a missing record": continuation({ records: [], lookups: [OWNER, ROOT] }),
    "a stale generation": continuation({ generationId: `${HANDLE}:completed:2026-01-01T00:00Z` }),
    "a receipt of another handle": continuation({
      receipt: { ...handleReceipt, taskId: "wst_other" },
    }),
    "a receipt of another final message": continuation({
      receipt: { ...handleReceipt, messageId: "older" },
    }),
    "a receipt of another report": continuation({
      receipt: { ...handleReceipt, reportMarkdown: "Other." },
    }),
    "a record that is not completed": continuation({
      records: [[OWNER, { ...TURN, status: "error" }]],
    }),
    "a record of another workspace": continuation({ records: [[OWNER, record("child-b")]] }),
    "an initial receipt and a record without a final message": continuation({
      records: [[OWNER, record(CHILD, HANDLE, { messageId: undefined })]],
      receipt: initialReceipt,
    }),
    "a generation that names no workspace turn": continuation({
      generationId: "exec-1:completed",
      receipt: childReceipt,
      lookups: [],
    }),
  });

  /**
   * Four wakes, one per child: a continuation found under ROOT, a first assignment whose report row
   * the answer covers, a continuation with no receipt and an uncovered report row, and a
   * continuation found under OWNER. Receipts and report rows count only for their own child.
   */
  async function setupFourWakes() {
    const [a, d] = [record("child-a", "wst_a"), record("child-d", "wst_d")];
    const rows = [
      reportRow(3, {}, "child-b"),
      reportRow(9, {}, "child-c"),
      answer({ requestHistorySequence: 4 }, [
        { ...handleReceipt, taskId: "wst_a", workspaceId: "child-a" },
        { ...handleReceipt, taskId: "wst_d", workspaceId: "child-d" },
      ]),
    ];
    const wakes = [
      { sourceId: "child-a", generationId: "wst_a" },
      { sourceId: "child-b" },
      { sourceId: "child-c", generationId: "wst_c" },
      { sourceId: "child-d", generationId: generationOf(d) },
    ];
    return await setup(rows, wakes, [
      [ROOT, a],
      [OWNER, d],
    ]);
  }

  test("decides and delivers each wake in turn, after one history and one config read", async () => {
    const fixture = await setupFourWakes();
    const [a, b, c, d] = fixture.ids;
    expect(await fixture.run()).toEqual({ consumed: [a, b, d], pending: [c] });
    expect(fixture.trace).toEqual([
      "pending",
      "history",
      "config",
      `record:${OWNER}`,
      `record:${ROOT}`,
      "generation",
      `delivered:${a}`,
      `delivered:${b}`,
      `record:${OWNER}`,
      "generation",
      `delivered:${d}`,
    ]);
  });

  test("a failed delivery rejects the call and leaves the later wakes pending", async () => {
    const fixture = await setupFourWakes();
    const failure = new Error("notification write failed");
    fixture.deliver.mockImplementationOnce((_owner, id) => {
      fixture.trace.push(`delivered:${id}`);
      return Promise.reject(failure);
    });
    const [a] = fixture.ids;
    await expect(fixture.acknowledge()).rejects.toBe(failure);
    expect(fixture.trace).toEqual([
      "pending",
      "history",
      "config",
      `record:${OWNER}`,
      `record:${ROOT}`,
      "generation",
      `delivered:${a}`,
    ]);
    expect(await fixture.listPendingIds()).toEqual(fixture.ids);
  });
});
