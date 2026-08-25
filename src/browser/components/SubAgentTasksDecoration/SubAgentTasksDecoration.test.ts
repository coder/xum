import { describe, expect, test } from "bun:test";

import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import {
  collectDescendantAgents,
  getSubAgentStatusPresentation,
  isSubAgentActive,
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
