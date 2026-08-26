import { describe, expect, test } from "bun:test";

import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import {
  collectDescendantAgents,
  getSubAgentStatusPresentation,
  isSubAgentActive,
  mergeRetainedWorkflowGroups,
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

describe("mergeRetainedWorkflowGroups", () => {
  const group = (runId: string, workerIds: string[]): WorkflowAgentGroup => ({
    runId,
    workflowName: `wf-${runId}`,
    workers: workerIds.map((id) => ({ workspace: workspace(id), depth: 1 })),
  });

  test("bridges the gap between sequential workers while the run stays active", () => {
    const retained = new Map<string, WorkflowAgentGroup>();
    // Step 1: a live worker exists.
    const withWorker = mergeRetainedWorkflowGroups([group("run-1", ["w1"])], ["run-1"], retained);
    expect(withWorker).toHaveLength(1);
    expect(withWorker[0].workers).toHaveLength(1);
    // Gap: the worker was deleted, the next one does not exist yet.
    const gap = mergeRetainedWorkflowGroups([], ["run-1"], retained);
    expect(gap).toHaveLength(1);
    expect(gap[0]).toEqual({ runId: "run-1", workflowName: "wf-run-1", workers: [] });
  });

  test("drops the retained group once the run leaves the active set", () => {
    const retained = new Map<string, WorkflowAgentGroup>();
    mergeRetainedWorkflowGroups([group("run-1", ["w1"])], ["run-1"], retained);
    expect(mergeRetainedWorkflowGroups([], [], retained)).toHaveLength(0);
    expect(retained.size).toBe(0);
  });

  test("live groups win over retained entries and are never duplicated", () => {
    const retained = new Map<string, WorkflowAgentGroup>();
    mergeRetainedWorkflowGroups([group("run-1", ["w1"])], ["run-1"], retained);
    mergeRetainedWorkflowGroups([], ["run-1"], retained);
    // The next worker appeared: its live rows must render, exactly once.
    const next = mergeRetainedWorkflowGroups([group("run-1", ["w2"])], ["run-1"], retained);
    expect(next).toHaveLength(1);
    expect(next[0].workers.map((worker) => worker.workspace.id)).toEqual(["w2"]);
  });

  test("passes through live groups whose run is not (yet) in the active set without retaining them", () => {
    const retained = new Map<string, WorkflowAgentGroup>();
    const merged = mergeRetainedWorkflowGroups([group("run-2", ["w1"])], [], retained);
    expect(merged).toHaveLength(1);
    expect(retained.size).toBe(0);
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
