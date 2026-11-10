// Pure parsers for task and workflow tool inputs, tool outputs and completed-report receipts.
// Moved out of taskService.ts unchanged so they read and test on their own; they hold no state.
import type { z } from "zod";
import type { MuxMessage } from "@/common/types/message";
import { isDynamicToolPart } from "@/common/types/toolParts";
import { isPlainObject } from "@/common/utils/isPlainObject";
import { getTaskGroupCount } from "@/common/utils/tools/taskGroups";
import { TaskToolArgsSchema } from "@/common/utils/tools/toolDefinitions";
import { isWorkflowRunEmittingToolName } from "@/common/utils/workflowRunMessages";
import { isWorkspaceTurnTaskId } from "@/node/services/taskHandleStore";
import { coerceNonEmptyString } from "@/node/services/taskUtils";
import { isWorkflowRunTaskId } from "@/node/services/tools/taskId";

const isWorkflowRunId = isWorkflowRunTaskId;

function collectWorkflowRunIdsFromToolOutput(output: unknown): string[] {
  if (output == null || typeof output !== "object") {
    return [];
  }

  const record = output as Record<string, unknown>;
  if (isWorkflowRunId(record.runId)) {
    return [record.runId];
  }

  const results = record.results;
  if (!Array.isArray(results)) {
    return [];
  }

  const runIds: string[] = [];
  for (const result of results) {
    if (result == null || typeof result !== "object") {
      continue;
    }
    const taskId = (result as Record<string, unknown>).taskId;
    if (isWorkflowRunId(taskId)) {
      runIds.push(taskId);
    }
  }
  return runIds;
}

/**
 * Tolerant extraction of the task IDs a persisted task tool output references. Recovery
 * bookkeeping must survive outputs written by newer releases (extra fields would fail the
 * strict result schema) so that a mid-stream downgrade cannot duplicate fallback reports.
 */
export function collectReferencedTaskIdsFromTaskToolOutput(
  output: unknown,
  into: Set<string>
): void {
  if (output == null || typeof output !== "object") {
    return;
  }
  const addTaskId = (value: unknown): void => {
    if (typeof value === "string" && value.length > 0) {
      into.add(value);
    }
  };

  const record = output as Record<string, unknown>;
  addTaskId(record.taskId);
  if (Array.isArray(record.taskIds)) {
    for (const taskId of record.taskIds) {
      addTaskId(taskId);
    }
  }
  for (const key of ["tasks", "reports"] as const) {
    const rows = record[key];
    if (!Array.isArray(rows)) {
      continue;
    }
    for (const row of rows) {
      if (row != null && typeof row === "object") {
        addTaskId((row as Record<string, unknown>).taskId);
      }
    }
  }
}

export type CompletedTaskReportReceipt = (
  | { kind: "initial"; taskId: string }
  | { kind: "continuation"; taskId: string; handleId?: string; messageId: string }
) & {
  reportMarkdown: string;
  /** Where reportMarkdown starts in the full report, when the row is one paged page. */
  pageOffset?: number;
};

/**
 * A paged row (task_await, or a foreground task since #6427) holds one page of a long report:
 * its pageOffset is its startCharOffset, 0 for a first page that only carries nextCharOffset.
 * Undefined for a whole report.
 */
function readReportPageOffset(row: Record<string, unknown>): number | undefined {
  if (typeof row.startCharOffset === "number") return row.startCharOffset;
  return typeof row.nextCharOffset === "number" ? 0 : undefined;
}

/**
 * Whether a continuation receipt shows the owner this exact report: the whole text, or any
 * non-empty page of it at the page's own offset. Reading one page (with its continuation note)
 * delivers the result, so its terminal notification must not wake the owner again.
 */
export function receiptMatchesReport(
  receipt: Extract<CompletedTaskReportReceipt, { kind: "continuation" }>,
  reportMarkdown: string | undefined
): boolean {
  if (receipt.reportMarkdown === reportMarkdown) return true;
  if (reportMarkdown == null || receipt.pageOffset == null) return false;
  return (
    receipt.reportMarkdown.length > 0 &&
    reportMarkdown.startsWith(receipt.reportMarkdown, receipt.pageOffset)
  );
}

/** Read only canonical task-result containers, never arbitrary JSON or prose. */
function completedTaskReports(toolName: unknown, output: unknown): CompletedTaskReportReceipt[] {
  if (!isPlainObject(output)) return [];
  const rows: unknown[] = [];
  if (toolName === "task") {
    if (output.status === "completed") rows.push(output);
    // A group can return completed members while other members are still running.
    if (Array.isArray(output.reports)) output.reports.forEach((row: unknown) => rows.push(row));
  } else if (toolName === "task_await" && Array.isArray(output.results)) {
    output.results.forEach((row: unknown) => {
      if (isPlainObject(row) && row.status === "completed") rows.push(row);
    });
  }
  return rows.flatMap((row): CompletedTaskReportReceipt[] => {
    if (
      !isPlainObject(row) ||
      typeof row.taskId !== "string" ||
      typeof row.reportMarkdown !== "string"
    )
      return [];
    const messageId =
      row.messageId ??
      (isPlainObject(row.finalMessageRef) ? row.finalMessageRef.messageId : undefined);
    // Workspace-target tools expose a handle; stable-child awaits expose the child itself.
    const handleId = isWorkspaceTurnTaskId(row.taskId) ? row.taskId : undefined;
    const taskId = handleId != null ? coerceNonEmptyString(row.workspaceId) : row.taskId;
    if (taskId == null) return [];
    if (typeof messageId === "string") {
      return [
        {
          kind: "continuation",
          taskId,
          handleId,
          messageId,
          reportMarkdown: row.reportMarkdown,
          pageOffset: readReportPageOffset(row),
        },
      ];
    }
    return handleId == null
      ? [
          {
            kind: "initial",
            taskId,
            reportMarkdown: row.reportMarkdown,
            pageOffset: readReportPageOffset(row),
          },
        ]
      : [];
  });
}

/**
 * Same text and same page position. A visible projection that drops a page's offset fields
 * (nextCharOffset/startCharOffset) hides that more text exists and where to read it, so it does
 * not prove delivery of the genuine paged row.
 */
function sameReportPage(a: CompletedTaskReportReceipt, b: CompletedTaskReportReceipt): boolean {
  return a.reportMarkdown === b.reportMarkdown && a.pageOffset === b.pageOffset;
}

function sameTaskReportReceipt(
  a: CompletedTaskReportReceipt,
  b: CompletedTaskReportReceipt
): boolean {
  return (
    a.kind === b.kind &&
    a.taskId === b.taskId &&
    sameReportPage(a, b) &&
    (a.kind === "initial" ||
      (b.kind === "continuation" && a.messageId === b.messageId && a.handleId === b.handleId))
  );
}

/** Only model-visible successful tool results prove consumption. UI telemetry does not. */
export function collectCompletedTaskReportReceipts(
  message: MuxMessage
): CompletedTaskReportReceipt[] {
  const reports: CompletedTaskReportReceipt[] = [];
  const succeeded = (call: unknown): call is Record<string, unknown> =>
    isPlainObject(call) &&
    call.failed !== true &&
    call.error == null &&
    call.ok !== false &&
    (call.state == null || call.state === "output-available");
  const visit = (call: unknown, depth: number): void => {
    if (depth > 30 || !succeeded(call)) return;
    const output = call.output ?? call.result;
    if (!isPlainObject(output)) return;
    reports.push(...completedTaskReports(call.toolName, output));
    if (call.toolName !== "code_execution") return;

    // Classic executions expose these result records to the model, even when a later
    // call fails. Persistent kernels replace them with summaries that contain no report.
    if (Array.isArray(output.toolCalls)) {
      for (const nested of output.toolCalls) visit(nested, depth + 1);
    }
    // Persistent nestedCalls hold UI-only full values. Use them solely as provenance for
    // a complete canonical report deliberately returned through output.result. Offload
    // handles, previews, hidden values, and unrelated returns must retain their wake.
    if (Array.isArray(call.nestedCalls)) {
      for (const nested of call.nestedCalls) {
        if (!succeeded(nested)) continue;
        const genuine = completedTaskReports(nested.toolName, nested.output);
        const visible = completedTaskReports(nested.toolName, output.result);
        reports.push(
          ...visible.filter((receipt) =>
            genuine.some((source) => sameTaskReportReceipt(source, receipt))
          )
        );
      }
    }
  };
  for (const part of message.parts) {
    if (isDynamicToolPart(part) && part.state === "output-available") visit(part, 0);
  }
  return reports;
}

interface RecoveredTaskToolInput {
  data: z.infer<typeof TaskToolArgsSchema>;
  groupCount: number;
  legacyVariants: boolean;
}

/**
 * Persisted partials may contain the removed `variants` input. Keep that field out of the
 * model-facing schema while accepting it narrowly during crash recovery so completed legacy
 * siblings can still finalize their parent tool call.
 */
export function parseTaskToolInputForRecovery(input: unknown): RecoveredTaskToolInput | null {
  const current = TaskToolArgsSchema.safeParse(input);
  if (current.success) {
    return {
      data: current.data,
      groupCount: getTaskGroupCount(current.data),
      legacyVariants: false,
    };
  }

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }

  const sanitized = { ...(input as Record<string, unknown>) };
  const variants = sanitized.variants;
  delete sanitized.variants;
  const parsed = TaskToolArgsSchema.safeParse(sanitized);
  if (!parsed.success) {
    return null;
  }

  if (variants == null) {
    return {
      data: parsed.data,
      groupCount: getTaskGroupCount(parsed.data),
      legacyVariants: false,
    };
  }
  if (!Array.isArray(variants) || variants.length < 1 || variants.length > 20) {
    return null;
  }

  const labels = variants.map((variant) => (typeof variant === "string" ? variant.trim() : ""));
  if (labels.some((label) => label.length === 0) || new Set(labels).size !== labels.length) {
    return null;
  }

  return {
    data: parsed.data,
    groupCount: labels.length,
    legacyVariants: true,
  };
}

function collectWorkflowRunIdsFromTaskAwaitInput(input: unknown): string[] {
  if (input == null || typeof input !== "object") {
    return [];
  }
  const taskIds = (input as Record<string, unknown>).task_ids;
  if (!Array.isArray(taskIds)) {
    return [];
  }
  return taskIds.filter(isWorkflowRunId);
}

export function collectAgentReferencedWorkflowRunIdsFromParts(
  parts: readonly unknown[],
  knownAgentRunIds: ReadonlySet<string>
): string[] {
  const runIds = new Set<string>();

  for (const part of parts) {
    if (!isDynamicToolPart(part) || part.state !== "output-available") {
      continue;
    }
    // workflow_resume re-establishes agent provenance the same way workflow_run does: both
    // outputs carry the runId of a run the agent explicitly owns.
    if (!isWorkflowRunEmittingToolName(part.toolName)) {
      continue;
    }
    for (const runId of collectWorkflowRunIdsFromToolOutput(part.output)) {
      runIds.add(runId);
    }
  }

  const allowedTaskAwaitRunIds = new Set([...knownAgentRunIds, ...runIds]);
  for (const part of parts) {
    if (!isDynamicToolPart(part) || part.state !== "output-available") {
      continue;
    }
    if (part.toolName !== "task_await") {
      continue;
    }

    // Omitted task_ids makes task_await discover every active run in the workspace, including
    // slash-command runs. Only treat task_await output as agent provenance when the model either
    // explicitly awaited that workflow ID in this turn or we already know the run was agent-started.
    for (const runId of collectWorkflowRunIdsFromTaskAwaitInput(part.input)) {
      runIds.add(runId);
      allowedTaskAwaitRunIds.add(runId);
    }
    for (const runId of collectWorkflowRunIdsFromToolOutput(part.output)) {
      if (allowedTaskAwaitRunIds.has(runId)) {
        runIds.add(runId);
      }
    }
  }

  return Array.from(runIds);
}
