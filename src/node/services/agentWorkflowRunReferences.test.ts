import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";

import {
  readAgentWorkflowRunReferences,
  recordAgentWorkflowRunReference,
} from "@/node/services/agentWorkflowRunReferences";

describe("agent workflow run references", () => {
  test("preserves concurrent run reference writes", async () => {
    const workspaceSessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-workflow-runs-"));
    try {
      const runIds = Array.from({ length: 20 }, (_, index) => `wfr_concurrent_${index}`);

      await Promise.all(
        runIds.map((runId, index) =>
          recordAgentWorkflowRunReference({
            workspaceSessionDir,
            runId,
            createdAtMs: 1_000 + index,
          })
        )
      );

      const references = await readAgentWorkflowRunReferences(workspaceSessionDir);
      expect(new Set(references.map((reference) => reference.runId))).toEqual(new Set(runIds));
    } finally {
      await fs.rm(workspaceSessionDir, { recursive: true, force: true });
    }
  });

  test("clamps future-dated createdAtMs to the current time", async () => {
    const workspaceSessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-workflow-runs-"));
    try {
      const runId = "wfr_future";
      await recordAgentWorkflowRunReference({
        workspaceSessionDir,
        runId,
        createdAtMs: Date.now() + 86_400_000,
      });

      const references = await readAgentWorkflowRunReferences(workspaceSessionDir);
      expect(references).toHaveLength(1);
      expect(references[0]?.createdAtMs).toBeLessThanOrEqual(Date.now());
    } finally {
      await fs.rm(workspaceSessionDir, { recursive: true, force: true });
    }
  });

  test("keeps the newest createdAtMs across re-records", async () => {
    const workspaceSessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-workflow-runs-"));
    try {
      const runId = "wfr_re_recorded";
      await recordAgentWorkflowRunReference({ workspaceSessionDir, runId, createdAtMs: 2_000 });
      await recordAgentWorkflowRunReference({ workspaceSessionDir, runId, createdAtMs: 1_000 });

      const references = await readAgentWorkflowRunReferences(workspaceSessionDir);
      expect(references).toEqual([{ runId, createdAtMs: 2_000 }]);
    } finally {
      await fs.rm(workspaceSessionDir, { recursive: true, force: true });
    }
  });
});
