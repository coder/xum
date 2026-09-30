import { describe, expect, test } from "bun:test";

import type { WorkflowRunRecord } from "@/common/types/workflow";
import { getNewestWorkflowRunSnapshot } from "./useWorkflowRunById";

function makeRun(input: {
  status: WorkflowRunRecord["status"];
  updatedAt: string;
  sequence: number;
}): WorkflowRunRecord {
  return {
    id: "wfr_child",
    workspaceId: "workspace-1",
    workflow: {
      name: "implementation-loop",
      description: "Implementation loop",
      scope: "global",
      executable: true,
    },
    source: "export default function workflow() { return null; }",
    sourceHash: "sha256:test",
    args: {},
    status: input.status,
    createdAt: "2026-06-26T00:00:00.000Z",
    updatedAt: input.updatedAt,
    events: [
      {
        sequence: input.sequence,
        type: "status",
        at: input.updatedAt,
        status: input.status,
      },
    ],
    steps: [],
  };
}

describe("getNewestWorkflowRunSnapshot", () => {
  test("keeps a terminal snapshot over a slower stale polling response", () => {
    const terminal = makeRun({
      status: "completed",
      updatedAt: "2026-06-26T00:00:02.000Z",
      sequence: 2,
    });
    const staleRunning = makeRun({
      status: "running",
      updatedAt: "2026-06-26T00:00:01.000Z",
      sequence: 1,
    });

    expect(getNewestWorkflowRunSnapshot(terminal, staleRunning)).toBe(terminal);
  });

  test("uses event sequence when snapshots share an updatedAt timestamp", () => {
    const older = makeRun({
      status: "running",
      updatedAt: "2026-06-26T00:00:02.000Z",
      sequence: 2,
    });
    const newer = makeRun({
      status: "completed",
      updatedAt: "2026-06-26T00:00:02.000Z",
      sequence: 3,
    });

    expect(getNewestWorkflowRunSnapshot(older, newer)).toBe(newer);
  });
});
