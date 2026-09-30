import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";

import { MAX_POST_COMPACTION_REPORT_INDEX_ENTRIES } from "@/common/constants/attachments";

import { AttachmentService } from "./attachmentService";
import { upsertSubagentReportArtifact } from "./subagentReportArtifacts";
import { DisposableTempDir } from "./tempDir";
import { WorkflowRunStore } from "./workflows/WorkflowRunStore";

const WORKSPACE_ID = "workspace-reports-test";

async function writeTaskReport(
  sessionDir: string,
  params: {
    childTaskId: string;
    updatedAtMs: number;
    parentWorkspaceId?: string;
    workflowOwnedAncestorWorkspaceIds?: string[];
    title?: string;
  }
): Promise<void> {
  await upsertSubagentReportArtifact({
    workspaceId: WORKSPACE_ID,
    workspaceSessionDir: sessionDir,
    childTaskId: params.childTaskId,
    parentWorkspaceId: params.parentWorkspaceId ?? WORKSPACE_ID,
    ancestorWorkspaceIds: [params.parentWorkspaceId ?? WORKSPACE_ID],
    reportMarkdown: "# Report\n\nSome findings.",
    ...(params.workflowOwnedAncestorWorkspaceIds
      ? { workflowOwnedAncestorWorkspaceIds: params.workflowOwnedAncestorWorkspaceIds }
      : {}),
    ...(params.title !== undefined ? { title: params.title } : {}),
    nowMs: params.updatedAtMs,
  });
}

async function writeWorkflowRun(
  sessionDir: string,
  params: {
    runId: string;
    workspaceId?: string;
    completedAt?: string;
    failed?: boolean;
    parentWorkflow?: {
      runId: string;
      stepId: string;
      inputHash: string;
      depth: number;
    };
    reportMarkdown?: string;
  }
): Promise<void> {
  const store = new WorkflowRunStore({ sessionDir });
  await store.createRun({
    id: params.runId,
    workspaceId: params.workspaceId ?? WORKSPACE_ID,
    workflow: {
      name: "deep-research",
      description: "Research a topic",
      scope: "built-in" as const,
      executable: true,
    },
    ...(params.parentWorkflow !== undefined ? { parentWorkflow: params.parentWorkflow } : {}),
    source: "export default async function workflow() { return 'ok'; }\n",
    args: {},
    now: "2026-06-01T00:00:00.000Z",
  });
  await store.appendNextEvent(params.runId, {
    type: "status",
    at: "2026-06-01T00:00:01.000Z",
    status: "running",
  });
  if (params.completedAt === undefined) {
    return; // leave the run active
  }
  if (params.failed) {
    await store.appendNextEvent(params.runId, {
      type: "error",
      at: params.completedAt,
      message: "boom",
    });
    await store.appendNextEvent(params.runId, {
      type: "status",
      at: params.completedAt,
      status: "failed",
    });
    return;
  }
  await store.appendNextEvent(params.runId, {
    type: "result",
    at: params.completedAt,
    result: { reportMarkdown: params.reportMarkdown ?? "# Workflow report" },
  });
  await store.appendNextEvent(params.runId, {
    type: "status",
    at: params.completedAt,
    status: "completed",
  });
}

describe("AttachmentService.generateCompletedReportsAttachment", () => {
  test("returns null when no completed reports exist", async () => {
    using tmp = new DisposableTempDir("completed-reports");

    const attachment = await AttachmentService.generateCompletedReportsAttachment({
      workspaceId: WORKSPACE_ID,
      sessionDir: tmp.path,
      completedBeforeMs: Date.now(),
    });

    expect(attachment).toBeNull();
  });

  test("includes only reports completed before the cutoff, newest first", async () => {
    using tmp = new DisposableTempDir("completed-reports");
    const cutoffMs = Date.parse("2026-06-02T00:00:00.000Z");

    await writeTaskReport(tmp.path, {
      childTaskId: "task-old",
      updatedAtMs: cutoffMs - 60_000,
      title: "Old exploration",
    });
    await writeTaskReport(tmp.path, {
      childTaskId: "task-new",
      updatedAtMs: cutoffMs + 60_000,
      title: "Still in context",
    });
    await writeWorkflowRun(tmp.path, {
      runId: "wfr_done",
      completedAt: "2026-06-01T12:00:00.000Z",
    });

    const attachment = await AttachmentService.generateCompletedReportsAttachment({
      workspaceId: WORKSPACE_ID,
      sessionDir: tmp.path,
      completedBeforeMs: cutoffMs,
    });

    expect(attachment).not.toBeNull();
    // Newest first: the task completed at cutoff-60s, the workflow 12h before that.
    expect(attachment?.reports.map((report) => report.id)).toEqual(["task-old", "wfr_done"]);
    const workflowEntry = attachment?.reports.find((report) => report.id === "wfr_done");
    expect(workflowEntry?.kind).toBe("workflow");
    expect(workflowEntry?.title).toBe("deep-research");
    expect(workflowEntry?.reportTokenEstimate).toBeGreaterThan(0);
    const taskEntry = attachment?.reports.find((report) => report.id === "task-old");
    expect(taskEntry?.kind).toBe("task");
    expect(taskEntry?.title).toBe("Old exploration");
    expect(taskEntry?.reportTokenEstimate).toBeGreaterThan(0);
  });

  test("excludes non-direct-children, workflow-owned reports, and non-completed runs", async () => {
    using tmp = new DisposableTempDir("completed-reports");
    const cutoffMs = Date.parse("2026-06-02T00:00:00.000Z");

    await writeTaskReport(tmp.path, {
      childTaskId: "task-grandchild",
      updatedAtMs: cutoffMs - 60_000,
      parentWorkspaceId: "some-child-workspace",
    });
    await writeTaskReport(tmp.path, {
      childTaskId: "task-workflow-owned",
      updatedAtMs: cutoffMs - 60_000,
      workflowOwnedAncestorWorkspaceIds: [WORKSPACE_ID],
    });
    await writeWorkflowRun(tmp.path, { runId: "wfr_active" });
    await writeWorkflowRun(tmp.path, {
      runId: "wfr_failed",
      completedAt: "2026-06-01T12:00:00.000Z",
      failed: true,
    });
    await writeWorkflowRun(tmp.path, {
      runId: "wfr_other_ws",
      workspaceId: "other-workspace",
      completedAt: "2026-06-01T12:00:00.000Z",
    });

    await writeWorkflowRun(tmp.path, {
      runId: "wfr_child_done",
      completedAt: "2026-06-01T12:00:00.000Z",
      parentWorkflow: {
        runId: "wfr_parent_done",
        stepId: "child",
        inputHash: "hash:child",
        depth: 0,
      },
    });

    const attachment = await AttachmentService.generateCompletedReportsAttachment({
      workspaceId: WORKSPACE_ID,
      sessionDir: tmp.path,
      completedBeforeMs: cutoffMs,
    });

    expect(attachment).toBeNull();
  });

  test("skips persisted index entries with malformed ids or timestamps", async () => {
    using tmp = new DisposableTempDir("completed-reports");
    const cutoffMs = Date.parse("2026-06-02T00:00:00.000Z");

    await writeTaskReport(tmp.path, { childTaskId: "task-valid", updatedAtMs: cutoffMs - 60_000 });
    // Corrupt the persisted index the way a partial/legacy write could: entries whose
    // updatedAtMs is missing or non-numeric, or whose id is missing.
    const indexPath = path.join(tmp.path, "subagent-reports.json");
    const file = JSON.parse(await fs.readFile(indexPath, "utf-8")) as {
      artifactsByChildTaskId: Record<string, unknown>;
    };
    const valid = file.artifactsByChildTaskId["task-valid"] as Record<string, unknown>;
    file.artifactsByChildTaskId["task-no-timestamp"] = {
      ...valid,
      childTaskId: "task-no-timestamp",
      updatedAtMs: undefined,
    };
    file.artifactsByChildTaskId["task-nan-timestamp"] = {
      ...valid,
      childTaskId: "task-nan-timestamp",
      updatedAtMs: "not-a-number",
    };
    file.artifactsByChildTaskId["task-no-id"] = { ...valid, childTaskId: undefined };
    file.artifactsByChildTaskId["task-null-row"] = null;
    file.artifactsByChildTaskId["task-string-row"] = "corrupt";
    // Corrupt ownership marker must degrade to "not workflow-owned", not throw.
    file.artifactsByChildTaskId["task-corrupt-owned"] = {
      ...valid,
      childTaskId: "task-corrupt-owned",
      updatedAtMs: cutoffMs - 30_000,
      workflowOwnedAncestorWorkspaceIds: "not-an-array",
    };
    await fs.writeFile(indexPath, JSON.stringify(file, null, 2));

    const attachment = await AttachmentService.generateCompletedReportsAttachment({
      workspaceId: WORKSPACE_ID,
      sessionDir: tmp.path,
      completedBeforeMs: cutoffMs,
    });

    expect(attachment?.reports.map((report) => report.id)).toEqual([
      "task-corrupt-owned",
      "task-valid",
    ]);
  });

  test("caps entries at the configured maximum, keeping the newest", async () => {
    using tmp = new DisposableTempDir("completed-reports");
    const cutoffMs = Date.parse("2026-06-02T00:00:00.000Z");
    const total = MAX_POST_COMPACTION_REPORT_INDEX_ENTRIES + 3;

    for (let i = 0; i < total; i++) {
      await writeTaskReport(tmp.path, {
        childTaskId: `task-${i}`,
        // Later index = newer completion.
        updatedAtMs: cutoffMs - 60_000 + i * 1_000,
      });
    }

    const attachment = await AttachmentService.generateCompletedReportsAttachment({
      workspaceId: WORKSPACE_ID,
      sessionDir: tmp.path,
      completedBeforeMs: cutoffMs,
    });

    expect(attachment?.reports).toHaveLength(MAX_POST_COMPACTION_REPORT_INDEX_ENTRIES);
    expect(attachment?.reports[0]?.id).toBe(`task-${total - 1}`);
    // Oldest entries beyond the cap are dropped.
    expect(attachment?.reports.map((report) => report.id)).not.toContain("task-0");
  });
});
