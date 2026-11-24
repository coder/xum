import { describe, expect, test } from "bun:test";

import type { MuxMessage } from "@/common/types/message";
import {
  collectAgentReferencedWorkflowRunIdsFromParts,
  collectCompletedTaskReportReceipts,
  collectReferencedTaskIdsFromTaskToolOutput,
  parseTaskToolInputForRecovery,
  receiptMatchesReport,
} from "@/node/services/taskToolOutputs";

function toolPart(toolName: string, output: unknown, input: unknown = {}) {
  return {
    type: "dynamic-tool",
    toolCallId: `call-${toolName}`,
    toolName,
    state: "output-available",
    input,
    output,
  };
}

function assistant(parts: unknown[]): MuxMessage {
  return { id: "msg-1", role: "assistant", parts } as unknown as MuxMessage;
}

describe("collectReferencedTaskIdsFromTaskToolOutput", () => {
  test("collects task IDs from every container and skips empty values", () => {
    const into = new Set<string>();
    collectReferencedTaskIdsFromTaskToolOutput(
      {
        taskId: "t1",
        taskIds: ["t2", "", 7],
        tasks: [{ taskId: "t3" }, null],
        reports: [{ taskId: "t4" }, { taskId: "" }],
        extraFieldFromNewerRelease: true,
      },
      into
    );
    expect([...into].sort()).toEqual(["t1", "t2", "t3", "t4"]);
  });

  test("ignores an output that is not an object", () => {
    const into = new Set<string>();
    collectReferencedTaskIdsFromTaskToolOutput("t1", into);
    expect(into.size).toBe(0);
  });
});

describe("receiptMatchesReport", () => {
  const receipt = (reportMarkdown: string, pageOffset?: number) => ({
    kind: "continuation" as const,
    taskId: "t1",
    messageId: "m1",
    reportMarkdown,
    pageOffset,
  });

  test("matches the whole text, or a non-empty page at its own offset", () => {
    expect(receiptMatchesReport(receipt("hello world"), "hello world")).toBe(true);
    expect(receiptMatchesReport(receipt("world", 6), "hello world")).toBe(true);
    expect(receiptMatchesReport(receipt("world", 0), "hello world")).toBe(false);
    expect(receiptMatchesReport(receipt("", 0), "hello world")).toBe(false);
    expect(receiptMatchesReport(receipt("world"), "hello world")).toBe(false);
    expect(receiptMatchesReport(receipt("world", 6), undefined)).toBe(false);
  });
});

describe("collectCompletedTaskReportReceipts", () => {
  test("reads completed task and task_await rows, with page offsets and continuation IDs", () => {
    const receipts = collectCompletedTaskReportReceipts(
      assistant([
        toolPart("task", { status: "completed", taskId: "t1", reportMarkdown: "r1" }),
        toolPart("task_await", {
          results: [
            {
              status: "completed",
              taskId: "t2",
              reportMarkdown: "page",
              startCharOffset: 40,
              messageId: "m2",
            },
            { status: "running", taskId: "t3", reportMarkdown: "not yet" },
            {
              status: "completed",
              taskId: "wst_abc",
              workspaceId: "ws1",
              reportMarkdown: "r4",
              finalMessageRef: { messageId: "m4" },
            },
            {
              status: "completed",
              taskId: "wst_def",
              workspaceId: "ws2",
              reportMarkdown: "no message id",
            },
          ],
        }),
      ])
    );
    expect(receipts).toEqual([
      { kind: "initial", taskId: "t1", reportMarkdown: "r1", pageOffset: undefined },
      {
        kind: "continuation",
        taskId: "t2",
        handleId: undefined,
        messageId: "m2",
        reportMarkdown: "page",
        pageOffset: 40,
      },
      {
        kind: "continuation",
        taskId: "ws1",
        handleId: "wst_abc",
        messageId: "m4",
        reportMarkdown: "r4",
        pageOffset: undefined,
      },
    ]);
  });

  test("a failed call proves nothing", () => {
    const failed = {
      ...toolPart("task", { status: "completed", taskId: "t1", reportMarkdown: "r1" }),
      failed: true,
    };
    expect(collectCompletedTaskReportReceipts(assistant([failed]))).toEqual([]);
  });

  test("a code_execution result counts only reports that a genuine nested call produced", () => {
    const genuine = { status: "completed", taskId: "t1", reportMarkdown: "r1" };
    const receipts = collectCompletedTaskReportReceipts(
      assistant([
        {
          ...toolPart("code_execution", {
            result: { status: "completed", taskId: "t1", reportMarkdown: "r1" },
          }),
          nestedCalls: [{ toolName: "task", output: genuine }],
        },
        {
          ...toolPart("code_execution", {
            result: { status: "completed", taskId: "t9", reportMarkdown: "forged" },
          }),
          nestedCalls: [{ toolName: "task", output: genuine }],
        },
      ])
    );
    expect(receipts).toEqual([
      { kind: "initial", taskId: "t1", reportMarkdown: "r1", pageOffset: undefined },
    ]);
  });
});

describe("parseTaskToolInputForRecovery", () => {
  const base = { agentId: "explore", prompt: "Look around", title: "Explorer" };

  test("parses current input with its group count", () => {
    expect(parseTaskToolInputForRecovery({ ...base, n: 3 })).toMatchObject({
      groupCount: 3,
      legacyVariants: false,
    });
  });

  test("accepts the removed variants field during recovery only with unique labels", () => {
    expect(parseTaskToolInputForRecovery({ ...base, variants: ["a", "b"] })).toMatchObject({
      groupCount: 2,
      legacyVariants: true,
    });
    expect(parseTaskToolInputForRecovery({ ...base, variants: ["a", "a"] })).toBeNull();
    expect(parseTaskToolInputForRecovery({ ...base, variants: [" "] })).toBeNull();
    expect(parseTaskToolInputForRecovery({ ...base, variants: [] })).toBeNull();
  });

  test("refuses input that fails the schema", () => {
    expect(parseTaskToolInputForRecovery({ ...base, prompt: "" })).toBeNull();
    expect(parseTaskToolInputForRecovery(["not", "an", "object"])).toBeNull();
  });
});

describe("collectAgentReferencedWorkflowRunIdsFromParts", () => {
  test("keeps runs the agent started or awaited by ID, not runs that task_await discovered", () => {
    const parts = [
      toolPart("workflow_run", { runId: "wfr_started" }),
      toolPart(
        "task_await",
        {
          results: [
            { taskId: "wfr_started" },
            { taskId: "wfr_named" },
            { taskId: "wfr_discovered" },
            { taskId: "wfr_known" },
          ],
        },
        { task_ids: ["wfr_named"] }
      ),
    ];
    expect(
      collectAgentReferencedWorkflowRunIdsFromParts(parts, new Set(["wfr_known"])).sort()
    ).toEqual(["wfr_known", "wfr_named", "wfr_started"]);
  });
});

describe("edge cases of the tolerant parsers", () => {
  test("ignores null outputs and rows, and keeps one-character task IDs", () => {
    const into = new Set<string>();
    collectReferencedTaskIdsFromTaskToolOutput(null, into);
    collectReferencedTaskIdsFromTaskToolOutput({ taskId: "a" }, into);
    expect([...into]).toEqual(["a"]);
  });

  test("a one-character page matches at its offset", () => {
    expect(
      receiptMatchesReport(
        { kind: "continuation", taskId: "t1", messageId: "m1", reportMarkdown: "d", pageOffset: 3 },
        "abcd"
      )
    ).toBe(true);
  });

  test("a first page that carries only nextCharOffset starts at 0", () => {
    const [receipt] = collectCompletedTaskReportReceipts(
      assistant([
        toolPart("task", {
          status: "completed",
          taskId: "t1",
          reportMarkdown: "page",
          nextCharOffset: 4,
        }),
      ])
    );
    expect(receipt?.pageOffset).toBe(0);
  });

  test("skips rows of other tools, malformed rows, unfinished calls and refused calls", () => {
    const row = { status: "completed", taskId: "t1", reportMarkdown: "r1" };
    expect(
      collectCompletedTaskReportReceipts(
        assistant([
          toolPart("bash", { results: [row] }),
          toolPart("task", { status: "completed", taskId: 7, reportMarkdown: "r" }),
          toolPart("task", { status: "completed", taskId: "t2", reportMarkdown: 7 }),
          toolPart("task", { reports: [null, "row"] }),
          { ...toolPart("task", row), state: "input-available" },
          { ...toolPart("task", row), ok: false },
          { ...toolPart("task", row), type: "text" },
        ])
      )
    ).toEqual([]);
  });

  test("reads a group's completed members and a report in a classic code_execution's toolCalls", () => {
    const receipts = collectCompletedTaskReportReceipts(
      assistant([
        toolPart("task", { status: "running", reports: [{ taskId: "t1", reportMarkdown: "r1" }] }),
        toolPart("code_execution", {
          toolCalls: [
            {
              toolName: "task",
              output: { status: "completed", taskId: "t2", reportMarkdown: "r2" },
            },
          ],
        }),
      ])
    );
    expect(receipts.map((receipt) => receipt.taskId)).toEqual(["t1", "t2"]);
  });

  test("a code_execution projection must match the genuine page, kind, message and handle", () => {
    const genuine = {
      status: "completed",
      taskId: "wst_a",
      workspaceId: "ws1",
      reportMarkdown: "page",
      startCharOffset: 10,
      messageId: "m1",
    };
    const project = (visible: Record<string, unknown>) =>
      collectCompletedTaskReportReceipts(
        assistant([
          {
            ...toolPart("code_execution", { result: { ...genuine, ...visible } }),
            nestedCalls: [{ toolName: "task", output: genuine }],
          },
        ])
      );
    expect(project({})).toHaveLength(1);
    expect(project({ startCharOffset: undefined })).toEqual([]);
    expect(project({ messageId: "m2" })).toEqual([]);
    expect(project({ taskId: "wst_b" })).toEqual([]);
    expect(project({ messageId: undefined })).toEqual([]);
  });

  test("a failed nested call proves nothing", () => {
    const row = { status: "completed", taskId: "t1", reportMarkdown: "r1" };
    expect(
      collectCompletedTaskReportReceipts(
        assistant([
          {
            ...toolPart("code_execution", { result: row }),
            nestedCalls: [{ toolName: "task", output: row, error: "boom" }],
          },
        ])
      )
    ).toEqual([]);
  });

  test("recovery accepts 1 to 20 variant labels and a null variants field", () => {
    const base = { agentId: "explore", prompt: "Look around", title: "Explorer" };
    const labels = (count: number) => Array.from({ length: count }, (_, i) => `v${i}`);
    expect(parseTaskToolInputForRecovery({ ...base, variants: labels(1) })?.groupCount).toBe(1);
    expect(parseTaskToolInputForRecovery({ ...base, variants: labels(20) })?.groupCount).toBe(20);
    expect(parseTaskToolInputForRecovery({ ...base, variants: labels(21) })).toBeNull();
    expect(parseTaskToolInputForRecovery({ ...base, variants: null })).toMatchObject({
      legacyVariants: false,
    });
  });

  test("workflow provenance ignores malformed parts and outputs", () => {
    const parts = [
      { ...toolPart("workflow_run", { runId: "wfr_text" }), type: "text" },
      { ...toolPart("workflow_run", { runId: "wfr_pending" }), state: "input-available" },
      toolPart("workflow_run", null),
      toolPart("workflow_run", { results: [null, { taskId: "wfr_row" }] }),
      toolPart("task_await", { results: [{ taskId: "wfr_unasked" }] }, null),
      {
        ...toolPart("task_await", { results: [{ taskId: "wfr_x" }] }, { task_ids: ["wfr_x"] }),
        state: "input-available",
      },
    ];
    expect(collectAgentReferencedWorkflowRunIdsFromParts(parts, new Set())).toEqual(["wfr_row"]);
  });
});
