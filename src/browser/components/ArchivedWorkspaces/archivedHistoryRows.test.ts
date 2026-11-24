import { describe, expect, test } from "bun:test";

import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";

import {
  expandHistorySelection,
  getHistoryRowCost,
  partitionArchivedHistoryRows,
} from "./archivedHistoryRows";

function archived(
  id: string,
  overrides: Partial<FrontendWorkspaceMetadata> = {}
): FrontendWorkspaceMetadata {
  return {
    id,
    name: id,
    projectName: "project",
    projectPath: "/tmp/project",
    createdAt: "2026-03-01T00:00:00.000Z",
    archivedAt: "2026-03-02T00:00:00.000Z",
    runtimeConfig: { type: "worktree", srcBaseDir: "/tmp/src" },
    namedWorkspacePath: `/tmp/src/project/${id}`,
    ...overrides,
  };
}

const worker = { runId: "run-1", stepId: "step-1" };

function partition(workspaces: FrontendWorkspaceMetadata[], liveIds: string[] = []) {
  const result = partitionArchivedHistoryRows(workspaces, new Set(liveIds));
  return {
    rows: result.rows.map((workspace) => workspace.id),
    folded: Object.fromEntries(
      Array.from(result.foldedByRowId, ([rowId, folded]) => [rowId, folded.map((w) => w.id)])
    ),
  };
}

describe("partitionArchivedHistoryRows", () => {
  test("folds a cascade-archived subtree into its archived root", () => {
    expect(
      partition([
        archived("grandchild", { parentWorkspaceId: "child" }),
        archived("root"),
        archived("child", { parentWorkspaceId: "root" }),
        archived("other"),
      ])
    ).toEqual({ rows: ["root", "other"], folded: { root: ["grandchild", "child"] } });
  });

  test("lists sub-agents whose parent is live or gone, so they stay restorable", () => {
    expect(
      partition(
        [
          archived("left-after-restore", { parentWorkspaceId: "live-parent" }),
          archived("orphan", { parentWorkspaceId: "removed-parent" }),
          archived("orphaned-worker", {
            parentWorkspaceId: "removed-parent",
            workflowTask: worker,
          }),
        ],
        ["live-parent"]
      )
    ).toEqual({ rows: ["left-after-restore", "orphan", "orphaned-worker"], folded: {} });
  });

  test("hides a workflow worker of a live parent together with its subtree", () => {
    expect(
      partition(
        [
          archived("worker", { parentWorkspaceId: "live-parent", workflowTask: worker }),
          archived("worker-child", { parentWorkspaceId: "worker" }),
          archived("user-chat"),
        ],
        ["live-parent"]
      )
    ).toEqual({ rows: ["user-chat"], folded: {} });
  });

  test("lists the members of a parent cycle instead of hiding them all", () => {
    expect(
      partition([
        archived("a", { parentWorkspaceId: "b" }),
        archived("b", { parentWorkspaceId: "a" }),
        archived("c", { parentWorkspaceId: "a" }),
      ])
    ).toEqual({ rows: ["a", "b", "c"], folded: {} });
  });
});

describe("archived history row helpers", () => {
  const folded = new Map([["root", [archived("child"), archived("grandchild")]]]);

  test("a row's cost adds its folded sub-agents' known costs", () => {
    expect(getHistoryRowCost("root", folded, { root: 1, child: 2 })).toBe(3);
    expect(getHistoryRowCost("root", folded, { grandchild: 0.5 })).toBe(0.5);
    // No known cost stays unknown rather than reading as $0.
    expect(getHistoryRowCost("root", folded, {})).toBeUndefined();
  });

  test("a selected row brings its folded sub-agents into the deletion, once", () => {
    expect(expandHistorySelection(["other", "root", "child"], folded)).toEqual([
      "other",
      "root",
      "child",
      "grandchild",
    ]);
  });

  test("outside WorkspaceProvider no parent counts as live, so workers stay listed", () => {
    const rows = partitionArchivedHistoryRows(
      [archived("worker", { parentWorkspaceId: "parent", workflowTask: worker })],
      undefined
    ).rows;
    expect(rows.map((workspace) => workspace.id)).toEqual(["worker"]);
  });
});
