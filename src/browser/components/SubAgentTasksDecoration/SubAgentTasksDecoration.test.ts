import { describe, expect, test } from "bun:test";

import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { WorkspaceSidebarState } from "@/browser/stores/WorkspaceStore";
import {
  collectDescendantAgents,
  decodeDescendantActivity,
  encodeDescendantActivity,
  getSubAgentStatusPresentation,
  isSubAgentActive,
  mergeActiveWorkflowGroups,
  reconcileNestedRunLiveness,
  type ObservedWorkflowRunInfo,
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
    ownerWorkspaceId: `owner-${runId}`,
    workers: workerIds.map((id) => ({ workspace: workspace(id), depth: 1 })),
  });
  const noneDead = () => false;

  test("bridges the gap between sequential workers while the run stays active", () => {
    const observed = new Map<string, ObservedWorkflowRunInfo>();
    // Step 1: a live worker exists (its group teaches name + owner).
    const withWorker = mergeActiveWorkflowGroups(
      [group("run-1", ["w1"])],
      ["run-1"],
      observed,
      noneDead
    );
    expect(withWorker).toHaveLength(1);
    expect(withWorker[0].workers).toHaveLength(1);
    // Gap: the worker was deleted, the next one does not exist yet.
    const gap = mergeActiveWorkflowGroups([], ["run-1"], observed, noneDead);
    expect(gap).toEqual([{ runId: "run-1", workflowName: "wf-run-1", workers: [] }]);
  });

  test("drops the synthesized group and observed entry once the run leaves the active set", () => {
    const observed = new Map<string, ObservedWorkflowRunInfo>();
    mergeActiveWorkflowGroups([group("run-1", ["w1"])], ["run-1"], observed, noneDead);
    expect(mergeActiveWorkflowGroups([], [], observed, noneDead)).toHaveLength(0);
    expect(observed.size).toBe(0);
  });

  test("live groups win over synthesized entries and are never duplicated", () => {
    const observed = new Map<string, ObservedWorkflowRunInfo>();
    mergeActiveWorkflowGroups([group("run-1", ["w1"])], ["run-1"], observed, noneDead);
    mergeActiveWorkflowGroups([], ["run-1"], observed, noneDead);
    // The next worker appeared: its live rows must render, exactly once.
    const next = mergeActiveWorkflowGroups([group("run-1", ["w2"])], ["run-1"], observed, noneDead);
    expect(next).toHaveLength(1);
    expect(next[0].workers.map((worker) => worker.workspace.id)).toEqual(["w2"]);
  });

  test("synthesizes a header-only group on a cold mount mid-gap (active run, nothing observed)", () => {
    const merged = mergeActiveWorkflowGroups([], ["run-cold"], new Map(), noneDead);
    expect(merged).toEqual([{ runId: "run-cold", workflowName: undefined, workers: [] }]);
  });

  test("bridges nested runs (never activity-covered) until their durable record settles", () => {
    // Backend excludes parentWorkflow runs from every workspace's activity, so the
    // nested id never appears in activeRunIds; liveness comes from the dead verdict.
    const observed = new Map<string, ObservedWorkflowRunInfo>();
    mergeActiveWorkflowGroups([group("run-nested", ["w1"])], [], observed, noneDead);
    const gap = mergeActiveWorkflowGroups([], [], observed, noneDead);
    expect(gap).toEqual([
      {
        runId: "run-nested",
        workflowName: "wf-run-nested",
        ownerWorkspaceId: "owner-run-nested",
        workers: [],
      },
    ]);
    // Durable record settled: the group drops out and the entry is pruned.
    const settled = mergeActiveWorkflowGroups([], [], observed, (runId) => runId === "run-nested");
    expect(settled).toHaveLength(0);
    expect(observed.size).toBe(0);
  });

  test("a run once seen in activity is reconciled against activity, not the nested verdict", () => {
    const observed = new Map<string, ObservedWorkflowRunInfo>();
    mergeActiveWorkflowGroups([group("run-top", ["w1"])], ["run-top"], observed, noneDead);
    // Run left the activity set: drop immediately even though noneDead says alive.
    expect(mergeActiveWorkflowGroups([], [], observed, noneDead)).toHaveLength(0);
    expect(observed.size).toBe(0);
  });

  test("keeps a discovery-seeded top-level run alive while activity is unavailable", () => {
    // The activity bootstrap can be down (list() returning null replays no
    // current state), so cold-mount discovery seeds the top-level run and the
    // durable-record poll owns its liveness until activity reports it.
    const observed = new Map<string, ObservedWorkflowRunInfo>([
      ["run-top", { workflowName: "deploy", ownerWorkspaceId: "ws-1", activityCovered: false }],
    ]);
    const gap = mergeActiveWorkflowGroups([], [], observed, noneDead);
    expect(gap).toHaveLength(1);
    expect(gap[0]).toMatchObject({ runId: "run-top", workflowName: "deploy" });
    // Activity recovers and reports the run: exactly one group (no duplicate)
    // and the entry flips to activity-covered, handing activity its lifecycle.
    expect(mergeActiveWorkflowGroups([], ["run-top"], observed, noneDead)).toHaveLength(1);
    expect(observed.get("run-top")?.activityCovered).toBe(true);
    // Activity later drops the run: it dies through the activity path even
    // though the durable poll never flagged it.
    expect(mergeActiveWorkflowGroups([], [], observed, noneDead)).toHaveLength(0);
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

describe("descendant activity hints", () => {
  /** Sidebar state of an idle child; `canInterrupt` stands in for a stale live hint. */
  function sidebarState(overrides: Partial<WorkspaceSidebarState> = {}): WorkspaceSidebarState {
    return {
      canInterrupt: false,
      isStarting: false,
      awaitingUserQuestion: false,
      lastAbortReason: null,
      currentModel: null,
      pendingStreamModel: null,
      recencyTimestamp: null,
      loadedSkills: [],
      skillLoadErrors: [],
      agentStatus: undefined,
      activeWorkflowRunCount: 0,
      activeBashMonitorCount: 0,
      terminalActiveCount: 0,
      terminalSessionCount: 0,
      ...overrides,
    };
  }
  const monitors = (count: number) => sidebarState({ activeBashMonitorCount: count });
  const reported = workspace("reported", { taskStatus: "reported" });
  const completed = workspace("completed", {
    taskStatus: "reported",
    taskExecutionStatus: "completed",
  });

  test("a reported child with no monitors stays inactive even under stale live hints", () => {
    const hints = decodeDescendantActivity(
      encodeDescendantActivity([reported.id], () => sidebarState({ canInterrupt: true }))
    ).get(reported.id);
    expect(hints).toEqual({ hasActiveBashMonitor: false, isLiveActive: true });
    expect(isSubAgentActive(reported, hints)).toBe(false);
    expect(getSubAgentStatusPresentation(reported, hints).label).toBe("Completed");
    expect(isSubAgentActive(completed, hints)).toBe(false);
    expect(getSubAgentStatusPresentation(completed, hints).label).toBe("Completed");
  });

  test("monitors arming and retiring on an unchanged child flip the snapshot and the row", () => {
    // Only the monitor count moves 0 -> 1 -> 0; the stale live hint stays true throughout.
    const keys = [0, 1, 0].map((count) =>
      encodeDescendantActivity([completed.id], () =>
        sidebarState({ activeBashMonitorCount: count, canInterrupt: true })
      )
    );
    // Monitor-only changes must produce a new snapshot so useSyncExternalStore re-renders,
    // and retirement must return to the exact previous snapshot (no spurious churn).
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[2]).toBe(keys[0]);
    const steps = keys.map((key) => {
      const hints = decodeDescendantActivity(key).get(completed.id);
      return {
        active: isSubAgentActive(completed, hints),
        presentation: getSubAgentStatusPresentation(completed, hints),
      };
    });
    expect(steps.map((step) => step.active)).toEqual([false, true, false]);
    expect(steps.map((step) => step.presentation.label)).toEqual([
      "Completed",
      "Monitoring",
      "Completed",
    ]);
    // Monitoring is a distinct settled-but-armed presentation, not a spinner.
    expect(steps[1].presentation.icon).not.toBe(steps[0].presentation.icon);
    expect(steps[1].presentation.iconClassName).not.toContain("animate-spin");
  });

  test("counts monitored children, not monitors, and partial retirement stays active", () => {
    const two = encodeDescendantActivity([reported.id], () => monitors(2));
    const one = encodeDescendantActivity([reported.id], () => monitors(1));
    expect(one).toBe(two);
    expect(isSubAgentActive(reported, decodeDescendantActivity(two).get(reported.id))).toBe(true);
  });

  test("a monitor moving between children with an unchanged total updates both rows", () => {
    const first = workspace("first", { taskStatus: "reported" });
    const second = workspace("second", { taskStatus: "reported" });
    const encode = (monitored: string) =>
      encodeDescendantActivity([first.id, second.id], (id) => monitors(id === monitored ? 1 : 0));
    const before = encode(first.id);
    const after = encode(second.id);
    expect(after).not.toBe(before);
    const label = (key: string, child: FrontendWorkspaceMetadata) =>
      getSubAgentStatusPresentation(child, decodeDescendantActivity(key).get(child.id)).label;
    expect([label(before, first), label(before, second)]).toEqual(["Monitoring", "Completed"]);
    expect([label(after, first), label(after, second)]).toEqual(["Completed", "Monitoring"]);
  });

  test("keeps queued, reawakened and unfinished live children active without monitors", () => {
    const noMonitor = sidebarState();
    const live = sidebarState({ canInterrupt: true });
    const decode = (child: FrontendWorkspaceMetadata, state: WorkspaceSidebarState) =>
      decodeDescendantActivity(encodeDescendantActivity([child.id], () => state)).get(child.id);
    const queued = workspace("queued", { taskStatus: "queued" });
    expect(isSubAgentActive(queued, decode(queued, noMonitor))).toBe(true);
    expect(getSubAgentStatusPresentation(queued, decode(queued, noMonitor)).label).toBe("Queued");
    const reawakened = workspace("reawakened", {
      taskStatus: "reported",
      taskExecutionStatus: "running",
    });
    expect(isSubAgentActive(reawakened, decode(reawakened, noMonitor))).toBe(true);
    // An interrupted child without a finalized report may still be streaming, so the
    // live hint decides, as it does for the sidebar.
    const interrupted = workspace("interrupted", { taskStatus: "interrupted" });
    expect(isSubAgentActive(interrupted, decode(interrupted, noMonitor))).toBe(false);
    expect(isSubAgentActive(interrupted, decode(interrupted, live))).toBe(true);
    // ...but a finalized report fences the live hint off.
    const finalized = workspace("finalized", {
      taskStatus: "interrupted",
      reportedAt: "2026-08-09T00:00:00.000Z",
    });
    expect(isSubAgentActive(finalized, decode(finalized, live))).toBe(false);
    // A question waiting on the user is not "working" for the sidebar either.
    const asking = sidebarState({ canInterrupt: true, awaitingUserQuestion: true });
    expect(isSubAgentActive(interrupted, decode(interrupted, asking))).toBe(false);
  });

  test("running rows keep their precedence over an armed monitor", () => {
    const running = workspace("running", { taskStatus: "running" });
    const hints = decodeDescendantActivity(
      encodeDescendantActivity([running.id], () => monitors(1))
    ).get(running.id);
    expect(getSubAgentStatusPresentation(running, hints).label).toBe("Running");
    const failed = workspace("failed", { taskStatus: "reported", taskExecutionStatus: "error" });
    expect(getSubAgentStatusPresentation(failed, hints).label).toBe("Failed");
  });

  test("missing or removed sidebar state reads as no hints", () => {
    const key = encodeDescendantActivity([reported.id, "gone"], (id) =>
      id === reported.id ? monitors(1) : null
    );
    const hints = decodeDescendantActivity(key);
    expect(hints.get("gone")).toEqual({ hasActiveBashMonitor: false, isLiveActive: false });
    expect(hints.get(reported.id)?.hasActiveBashMonitor).toBe(true);
    expect(decodeDescendantActivity(encodeDescendantActivity([], () => null)).size).toBe(0);
    // A descendant absent from the snapshot (undefined hints) falls back to metadata alone.
    expect(isSubAgentActive(reported, hints.get("never-encoded"))).toBe(false);
    expect(getSubAgentStatusPresentation(reported, hints.get("never-encoded")).label).toBe(
      "Completed"
    );
  });
});

describe("reconcileNestedRunLiveness", () => {
  test("kills settled and missing durable records immediately", () => {
    const failureCounts = new Map<string, number>();
    const dead = reconcileNestedRunLiveness({
      candidateRunIds: ["wfr_done", "wfr_missing", "wfr_live"],
      entries: [
        { runId: "wfr_done", status: "completed" },
        { runId: "wfr_missing", status: null },
        { runId: "wfr_live", status: "running" },
      ],
      failureCounts,
      maxFailures: 3,
    });
    expect(dead).toEqual(["wfr_done", "wfr_missing"]);
    expect(failureCounts.size).toBe(0);
  });

  test("kills an unreachable run only after consecutive failed cycles", () => {
    const failureCounts = new Map<string, number>();
    const cycle = (
      entries: ReadonlyArray<{ runId: string; status: "running" | null }> | null
    ): string[] =>
      reconcileNestedRunLiveness({
        candidateRunIds: ["wfr_gap"],
        entries,
        failureCounts,
        maxFailures: 3,
      });

    // Two failures (whole call, then per-ref omission) keep the group alive...
    expect(cycle(null)).toEqual([]);
    expect(cycle([])).toEqual([]);
    // ...a successful read resets the streak...
    expect(cycle([{ runId: "wfr_gap", status: "running" }])).toEqual([]);
    expect(failureCounts.get("wfr_gap")).toBeUndefined();
    // ...so a fresh streak needs the full threshold again.
    expect(cycle(null)).toEqual([]);
    expect(cycle(null)).toEqual([]);
    expect(cycle(null)).toEqual(["wfr_gap"]);
  });

  test("counts a per-ref omission only against the omitted run", () => {
    const failureCounts = new Map<string, number>();
    const dead = reconcileNestedRunLiveness({
      candidateRunIds: ["wfr_ok", "wfr_gone"],
      entries: [{ runId: "wfr_ok", status: "backgrounded" }],
      failureCounts,
      maxFailures: 3,
    });
    expect(dead).toEqual([]);
    expect(failureCounts.get("wfr_gone")).toBe(1);
    expect(failureCounts.get("wfr_ok")).toBeUndefined();
  });
});
