import { describe, expect, test } from "bun:test";

import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import {
  collectDescendantAgents,
  getSubAgentStatusPresentation,
  isSubAgentActive,
  mergeActiveWorkflowGroups,
  type WorkflowAgentGroup,
} from "./SubAgentTasksDecoration";

function workspace(
  id: string,
  options: Partial<FrontendWorkspaceMetadata> = {}
): FrontendWorkspaceMetadata {
  return {
    id,
    name: id,
    projectName: "mux",
    projectPath: "/repo/mux",
    namedWorkspacePath: `/tmp/${id}`,
    runtimeConfig: DEFAULT_RUNTIME_CONFIG,
    ...options,
  };
}

describe("mergeActiveWorkflowGroups", () => {
  const group = (runId: string, workerIds: string[]): WorkflowAgentGroup => ({
    runId,
    workflowName: `wf-${runId}`,
    workers: workerIds.map((id) => ({ workspace: workspace(id), depth: 1 })),
  });

  test("bridges the gap between sequential workers while the run stays active", () => {
    const runNames = new Map<string, string>();
    // Step 1: a live worker exists (its group teaches the display name).
    const withWorker = mergeActiveWorkflowGroups([group("run-1", ["w1"])], ["run-1"], runNames);
    expect(withWorker).toHaveLength(1);
    expect(withWorker[0].workers).toHaveLength(1);
    // Gap: the worker was deleted, the next one does not exist yet.
    const gap = mergeActiveWorkflowGroups([], ["run-1"], runNames);
    expect(gap).toEqual([{ runId: "run-1", workflowName: "wf-run-1", workers: [] }]);
  });

  test("drops the synthesized group and cached name once the run leaves the active set", () => {
    const runNames = new Map<string, string>();
    mergeActiveWorkflowGroups([group("run-1", ["w1"])], ["run-1"], runNames);
    expect(mergeActiveWorkflowGroups([], [], runNames)).toHaveLength(0);
    expect(runNames.size).toBe(0);
  });

  test("live groups win over synthesized entries and are never duplicated", () => {
    const runNames = new Map<string, string>();
    mergeActiveWorkflowGroups([group("run-1", ["w1"])], ["run-1"], runNames);
    mergeActiveWorkflowGroups([], ["run-1"], runNames);
    // The next worker appeared: its live rows must render, exactly once.
    const next = mergeActiveWorkflowGroups([group("run-1", ["w2"])], ["run-1"], runNames);
    expect(next).toHaveLength(1);
    expect(next[0].workers.map((worker) => worker.workspace.id)).toEqual(["w2"]);
  });

  test("synthesizes a header-only group on a cold mount mid-gap (active run, nothing observed)", () => {
    const merged = mergeActiveWorkflowGroups([], ["run-cold"], new Map());
    expect(merged).toEqual([{ runId: "run-cold", workflowName: undefined, workers: [] }]);
  });

  test("bridges descendant-owned runs, which appear only in the descendant's active set", () => {
    // The component unions active ids across root + descendants; the merge itself
    // must treat a descendant-owned id exactly like a root-owned one.
    const runNames = new Map<string, string>();
    mergeActiveWorkflowGroups([group("run-nested", ["w1"])], ["run-nested"], runNames);
    const gap = mergeActiveWorkflowGroups([], ["run-nested"], runNames);
    expect(gap).toEqual([{ runId: "run-nested", workflowName: "wf-run-nested", workers: [] }]);
  });

  test("passes through live groups whose run is not (yet) in the active set, pruning names once gone", () => {
    const runNames = new Map<string, string>();
    const merged = mergeActiveWorkflowGroups([group("run-2", ["w1"])], [], runNames);
    expect(merged).toHaveLength(1);
    // Name retained while the group is visible, pruned once inactive and gone.
    expect(runNames.get("run-2")).toBe("wf-run-2");
    mergeActiveWorkflowGroups([], [], runNames);
    expect(runNames.size).toBe(0);
  });
});

describe("collectDescendantAgents", () => {
  test("splits persistent user-owned descendants from workflow workers and excludes archived rows", () => {
    const workspaces = [
      workspace("parent"),
      workspace("running", { parentWorkspaceId: "parent", taskStatus: "running" }),
      workspace("completed", { parentWorkspaceId: "parent", taskStatus: "reported" }),
      workspace("nested", { parentWorkspaceId: "running", taskStatus: "reported" }),
      workspace("archived", {
        parentWorkspaceId: "parent",
        taskStatus: "reported",
        archivedAt: "2026-08-09T00:00:00.000Z",
      }),
      workspace("workflow", {
        parentWorkspaceId: "parent",
        taskStatus: "running",
        workflowTask: { runId: "run", stepId: "step", workflowName: "deep-research" },
      }),
      workspace("workflow-child", { parentWorkspaceId: "workflow", taskStatus: "reported" }),
    ];

    const { subAgents, workflowGroups } = collectDescendantAgents(workspaces, "parent");
    expect(subAgents.map(({ workspace, depth }) => ({ id: workspace.id, depth }))).toEqual([
      { id: "running", depth: 1 },
      { id: "nested", depth: 2 },
      { id: "completed", depth: 1 },
    ]);
    // Workflow workers group per run; a user-owned task spawned by a worker stays
    // inside that run's group instead of leaking into the parent's bench.
    expect(
      workflowGroups.map((group) => ({
        runId: group.runId,
        workflowName: group.workflowName,
        workers: group.workers.map(({ workspace, depth }) => ({ id: workspace.id, depth })),
      }))
    ).toEqual([
      {
        runId: "run",
        workflowName: "deep-research",
        workers: [
          { id: "workflow", depth: 1 },
          { id: "workflow-child", depth: 2 },
        ],
      },
    ]);
  });

  test("groups nested workflow runs separately from the spawning run", () => {
    const workspaces = [
      workspace("parent"),
      workspace("outer-worker", {
        parentWorkspaceId: "parent",
        taskStatus: "running",
        workflowTask: { runId: "outer", stepId: "step-1" },
      }),
      workspace("inner-worker", {
        parentWorkspaceId: "outer-worker",
        taskStatus: "running",
        workflowTask: { runId: "inner", stepId: "step-1", workflowName: "inner-flow" },
      }),
      workspace("archived-worker", {
        parentWorkspaceId: "parent",
        taskStatus: "interrupted",
        workflowTask: { runId: "outer", stepId: "step-2" },
        archivedAt: "2026-08-09T00:00:00.000Z",
      }),
    ];

    const { subAgents, workflowGroups } = collectDescendantAgents(workspaces, "parent");
    expect(subAgents).toEqual([]);
    expect(
      workflowGroups.map((group) => ({
        runId: group.runId,
        workflowName: group.workflowName,
        workers: group.workers.map(({ workspace }) => workspace.id),
      }))
    ).toEqual([
      { runId: "outer", workflowName: undefined, workers: ["outer-worker"] },
      { runId: "inner", workflowName: "inner-flow", workers: ["inner-worker"] },
    ]);
  });

  test("classifies actionable base and continuation statuses as active", () => {
    expect(isSubAgentActive(workspace("queued", { taskStatus: "queued" }))).toBe(true);
    expect(isSubAgentActive(workspace("finishing", { taskStatus: "awaiting_report" }))).toBe(true);
    expect(
      isSubAgentActive(
        workspace("reawakened", { taskStatus: "reported", taskExecutionStatus: "running" })
      )
    ).toBe(true);
    expect(isSubAgentActive(workspace("reported", { taskStatus: "reported" }))).toBe(false);
    expect(isSubAgentActive(workspace("interrupted", { taskStatus: "interrupted" }))).toBe(false);
  });

  test("presents terminal continuation outcomes instead of the retained base report", () => {
    expect(
      getSubAgentStatusPresentation(
        workspace("completed", { taskStatus: "reported", taskExecutionStatus: "completed" })
      ).label
    ).toBe("Completed");
    expect(
      getSubAgentStatusPresentation(
        workspace("interrupted", { taskStatus: "reported", taskExecutionStatus: "interrupted" })
      ).label
    ).toBe("Interrupted");
    expect(
      getSubAgentStatusPresentation(
        workspace("failed", { taskStatus: "reported", taskExecutionStatus: "error" })
      ).label
    ).toBe("Failed");
  });
});
