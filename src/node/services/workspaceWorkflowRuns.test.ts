import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { ProjectsConfig } from "@/common/types/project";
import {
  WorkflowRunStore,
  type WorkflowRunStatusSnapshot,
} from "@/node/services/workflows/WorkflowRunStore";
import { WorkspaceWorkflowRuns } from "@/node/services/workspaceWorkflowRuns";

const ARCHIVED = "archived-ws";

// Only the fields findWorkspaceEntry and isWorkspaceArchived read.
const projectsConfig = {
  projects: new Map([
    ["/repo", { workspaces: [{ id: ARCHIVED, archivedAt: "2026-10-01T00:00:00.000Z" }] }],
  ]),
} as unknown as ProjectsConfig;

function run(
  id: string,
  workspaceId: string,
  status: WorkflowRunStatusSnapshot["status"],
  extra: Partial<WorkflowRunStatusSnapshot> = {}
): WorkflowRunStatusSnapshot {
  const snapshot: WorkflowRunStatusSnapshot = {
    id,
    workspaceId,
    status,
    createdAt: "2026-10-26T00:00:00.000Z",
    updatedAt: "2026-10-26T00:00:00.000Z",
    ...extra,
  };
  return snapshot;
}

describe("WorkspaceWorkflowRuns", () => {
  let snapshots: WorkflowRunStatusSnapshot[];
  let scans: number;
  let listSpy: { mockRestore(): void };
  let runs: WorkspaceWorkflowRuns;

  beforeEach(() => {
    snapshots = [];
    scans = 0;
    listSpy = spyOn(WorkflowRunStore.prototype, "listRunStatusSnapshots").mockImplementation(() => {
      scans += 1;
      return Promise.resolve(snapshots);
    });
    runs = new WorkspaceWorkflowRuns({
      config: {
        sessionsDir: "/tmp/xum-workflow-runs-test",
        loadConfigOrDefault: () => projectsConfig,
      },
    });
  });

  afterEach(() => {
    listSpy.mockRestore();
  });

  test("the first read counts only the workspace's own active top-level runs, once", async () => {
    snapshots = [
      run("wfr_running", "ws", "running"),
      run("wfr_done", "ws", "completed"),
      run("wfr_child", "ws", "running", {
        parentWorkflow: { runId: "wfr_running", stepId: "s", inputHash: "h", depth: 1 },
      }),
      run("wfr_other", "other-ws", "running"),
    ];
    expect([...(await runs.getActiveWorkflowRunIds("ws"))]).toEqual(["wfr_running"]);
    expect(runs.hasSeenWorkflowRuns("ws")).toBe(true);
    await runs.getActiveWorkflowRunIds("ws");
    expect(scans).toBe(1);
  });

  test("status events add and remove runs; an idle workspace is never marked seen", async () => {
    expect(
      await runs.updateActiveWorkflowRunCount({ workspaceId: "ws", runId: "a", status: "running" })
    ).toBe(1);
    expect(
      await runs.updateActiveWorkflowRunCount({
        workspaceId: "ws",
        runId: "a",
        status: "completed",
      })
    ).toBe(0);
    expect(runs.hasSeenWorkflowRuns("ws")).toBe(true);

    expect((await runs.getActiveWorkflowRunIds("idle")).size).toBe(0);
    expect(runs.hasSeenWorkflowRuns("idle")).toBe(false);
  });

  test("an archived workspace's read installs no cache, but its status events do", async () => {
    snapshots = [run("wfr_old", ARCHIVED, "running")];
    expect((await runs.getActiveWorkflowRunIds(ARCHIVED)).size).toBe(0);
    expect(scans).toBe(0);
    expect(runs.installedActiveWorkflowRunIds(ARCHIVED)).toBeUndefined();

    await runs.updateActiveWorkflowRunCount({
      workspaceId: ARCHIVED,
      runId: "wfr_live",
      status: "running",
    });
    expect([...(runs.installedActiveWorkflowRunIds(ARCHIVED) ?? [])]).toEqual(["wfr_live"]);
  });

  test("eviction drops the cache and the seen marker; invalidation keeps the marker", async () => {
    await runs.updateActiveWorkflowRunCount({ workspaceId: "ws", runId: "a", status: "running" });

    runs.invalidateActiveWorkflowRunIds("ws");
    expect(runs.installedActiveWorkflowRunIds("ws")).toBeUndefined();
    expect([...runs.seenWorkspaceIds()]).toEqual(["ws"]);

    await runs.getActiveWorkflowRunIds("ws");
    expect([...runs.cachedWorkspaceIds()]).toEqual(["ws"]);
    runs.evictWorkflowRunCaches("ws");
    expect([...runs.cachedWorkspaceIds()]).toEqual([]);
    expect(runs.hasSeenWorkflowRuns("ws")).toBe(false);
  });
});
