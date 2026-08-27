import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";

import {
  clearAgentWorkflowRunReferences,
  getSidecarLifecycleGeneration,
  readAgentWorkflowRunReferences,
  recordAgentWorkflowRunReference,
  scheduleAgentWorkflowRunReferenceRecordRetry,
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

  test("collapses persisted duplicate entries to the newest sane timestamp", async () => {
    const workspaceSessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-workflow-runs-"));
    try {
      // Corrupted files can carry duplicates in either order; order-sensitive consumers must
      // never observe a stale duplicate ahead of a legitimate re-record.
      await fs.writeFile(
        path.join(workspaceSessionDir, "agent-workflow-runs.json"),
        JSON.stringify({
          references: [
            { runId: "wfr_dup", createdAtMs: 1_000 },
            { runId: "wfr_dup", createdAtMs: 2_000 },
            { runId: "wfr_dup_reversed", createdAtMs: 2_000 },
            { runId: "wfr_dup_reversed", createdAtMs: 1_000 },
          ],
        })
      );

      const references = await readAgentWorkflowRunReferences(workspaceSessionDir);
      expect(references).toHaveLength(2);
      expect(references).toContainEqual({ runId: "wfr_dup", createdAtMs: 2_000 });
      expect(references).toContainEqual({ runId: "wfr_dup_reversed", createdAtMs: 2_000 });
    } finally {
      await fs.rm(workspaceSessionDir, { recursive: true, force: true });
    }
  });

  test("drops persisted future-dated references and repairs them on the next record", async () => {
    const workspaceSessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-workflow-runs-"));
    try {
      const futureMs = Date.now() + 86_400_000;
      await fs.writeFile(
        path.join(workspaceSessionDir, "agent-workflow-runs.json"),
        JSON.stringify({
          references: [
            { runId: "wfr_corrupt_future", createdAtMs: futureMs },
            { runId: "wfr_sane", createdAtMs: 1_000 },
          ],
        })
      );

      // A per-read clamp would re-evaluate to "now" on every read and outrank every later
      // user/reset boundary; the corrupted entry must be dropped instead.
      expect(await readAgentWorkflowRunReferences(workspaceSessionDir)).toEqual([
        { runId: "wfr_sane", createdAtMs: 1_000 },
      ]);

      await recordAgentWorkflowRunReference({
        workspaceSessionDir,
        runId: "wfr_corrupt_future",
        createdAtMs: 2_000,
      });
      const repaired = await readAgentWorkflowRunReferences(workspaceSessionDir);
      expect(repaired).toContainEqual({ runId: "wfr_corrupt_future", createdAtMs: 2_000 });
      const raw = await fs.readFile(
        path.join(workspaceSessionDir, "agent-workflow-runs.json"),
        "utf-8"
      );
      expect(raw).not.toContain(String(futureMs));
    } finally {
      await fs.rm(workspaceSessionDir, { recursive: true, force: true });
    }
  });

  test("keeps references within the backward-clock skew tolerance", async () => {
    const workspaceSessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-workflow-runs-"));
    try {
      // A backward clock correction makes a legitimately recorded reference look slightly
      // future-dated; dropping it would strand the run's terminal wake.
      const slightlyFutureMs = Date.now() + 5 * 60_000;
      await fs.writeFile(
        path.join(workspaceSessionDir, "agent-workflow-runs.json"),
        JSON.stringify({ references: [{ runId: "wfr_clock_skew", createdAtMs: slightlyFutureMs }] })
      );

      expect(await readAgentWorkflowRunReferences(workspaceSessionDir)).toEqual([
        { runId: "wfr_clock_skew", createdAtMs: slightlyFutureMs },
      ]);
    } finally {
      await fs.rm(workspaceSessionDir, { recursive: true, force: true });
    }
  });

  test("rejects entries with a present-but-invalid boundary snapshot", async () => {
    const workspaceSessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-workflow-runs-"));
    try {
      // "" and non-string values are corruption, not legacy records: migrating them into the
      // wall-clock fallback could outrank a newer boundary during tolerated clock skew.
      await fs.writeFile(
        path.join(workspaceSessionDir, "agent-workflow-runs.json"),
        JSON.stringify({
          references: [
            { runId: "wfr_empty_boundary", createdAtMs: 1_000, afterBoundaryMessageId: "" },
            { runId: "wfr_numeric_boundary", createdAtMs: 1_000, afterBoundaryMessageId: 42 },
            { runId: "wfr_valid_boundary", createdAtMs: 1_000, afterBoundaryMessageId: "row-1" },
            { runId: "wfr_null_boundary", createdAtMs: 1_000, afterBoundaryMessageId: null },
          ],
        })
      );

      const references = await readAgentWorkflowRunReferences(workspaceSessionDir);
      expect(new Set(references.map((reference) => reference.runId))).toEqual(
        new Set(["wfr_valid_boundary", "wfr_null_boundary"])
      );
    } finally {
      await fs.rm(workspaceSessionDir, { recursive: true, force: true });
    }
  });

  test("propagates non-ENOENT read failures instead of flattening them to empty", async () => {
    const workspaceSessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-workflow-runs-"));
    try {
      // A directory at the file path fails reads with EISDIR. Callers deciding wake delivery
      // must observe the failure rather than "no references".
      await fs.mkdir(path.join(workspaceSessionDir, "agent-workflow-runs.json"));
      let readError: unknown;
      try {
        await readAgentWorkflowRunReferences(workspaceSessionDir);
      } catch (error: unknown) {
        readError = error;
      }
      expect(String(readError)).toContain("EISDIR");
    } finally {
      await fs.rm(workspaceSessionDir, { recursive: true, force: true });
    }
  });

  test("record propagates a sidecar read failure instead of clobbering existing references", async () => {
    const workspaceSessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-workflow-runs-"));
    try {
      await recordAgentWorkflowRunReference({
        workspaceSessionDir,
        runId: "wfr_existing",
        createdAtMs: 1_000,
      });
      const filePath = path.join(workspaceSessionDir, "agent-workflow-runs.json");
      // Unreadable file, writable directory: the atomic rewrite could replace contents it
      // never saw, destroying every other run's only durable provenance.
      await fs.chmod(filePath, 0o000);
      let recordError: unknown;
      try {
        await recordAgentWorkflowRunReference({
          workspaceSessionDir,
          runId: "wfr_new",
          createdAtMs: 2_000,
        });
      } catch (error: unknown) {
        recordError = error;
      } finally {
        await fs.chmod(filePath, 0o600);
      }
      expect(String(recordError)).toContain("EACCES");
      const references = await readAgentWorkflowRunReferences(workspaceSessionDir);
      expect(references.map((reference) => reference.runId)).toEqual(["wfr_existing"]);
    } finally {
      await fs.rm(workspaceSessionDir, { recursive: true, force: true });
    }
  });

  test("a pending record retry never overwrites newer provenance", async () => {
    const workspaceSessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-workflow-runs-"));
    try {
      // The retry carries the stale launch-time snapshot; a workflow_resume records newer
      // provenance before the timer fires. Fill-absence semantics must let the newer record win.
      scheduleAgentWorkflowRunReferenceRecordRetry({
        workspaceSessionDir,
        runId: "wfr_lifecycle",
        createdAtMs: 1_000,
        afterBoundaryMessageId: "stale-row",
        retryDelaysMs: [150],
      });
      await recordAgentWorkflowRunReference({
        workspaceSessionDir,
        runId: "wfr_lifecycle",
        createdAtMs: 2_000,
        afterBoundaryMessageId: "resume-row",
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
      const references = await readAgentWorkflowRunReferences(workspaceSessionDir);
      expect(references).toHaveLength(1);
      expect(references[0]).toMatchObject({
        runId: "wfr_lifecycle",
        afterBoundaryMessageId: "resume-row",
      });
    } finally {
      await fs.rm(workspaceSessionDir, { recursive: true, force: true });
    }
  });

  test("a retry supersedes an older entry for the same run", async () => {
    const workspaceSessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-workflow-runs-"));
    try {
      // A workflow_resume re-record fails transiently while an OLDER dispatch entry exists.
      // The retry must replace that stale provenance (its boundary predates the resume) or the
      // resumed run's wake is classified not_current; only a strictly newer record wins.
      await recordAgentWorkflowRunReference({
        workspaceSessionDir,
        runId: "wfr_supersede",
        createdAtMs: 500,
        afterBoundaryMessageId: "old-row",
      });
      scheduleAgentWorkflowRunReferenceRecordRetry({
        workspaceSessionDir,
        runId: "wfr_supersede",
        createdAtMs: 2_000,
        afterBoundaryMessageId: "resume-row",
        retryDelaysMs: [50],
      });
      const deadline = Date.now() + 5_000;
      let boundary: string | null | undefined;
      while (Date.now() < deadline) {
        boundary = (await readAgentWorkflowRunReferences(workspaceSessionDir)).find(
          (reference) => reference.runId === "wfr_supersede"
        )?.afterBoundaryMessageId;
        if (boundary === "resume-row") {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(boundary).toBe("resume-row");
    } finally {
      await fs.rm(workspaceSessionDir, { recursive: true, force: true });
    }
  });

  test("a chain scheduled before cancellation cannot re-arm after it", async () => {
    const workspaceSessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-workflow-runs-"));
    try {
      // Simulates the reschedule window: a failing in-flight write's catch handler schedules
      // the next retry DURING the cancellation drain, carrying the pre-cancel generation.
      // Registration must refuse it, or the retry recreates the retired sidecar later.
      const staleGeneration = getSidecarLifecycleGeneration(workspaceSessionDir);
      await clearAgentWorkflowRunReferences(workspaceSessionDir);
      scheduleAgentWorkflowRunReferenceRecordRetry({
        workspaceSessionDir,
        runId: "wfr_stale_chain",
        createdAtMs: 1_000,
        afterBoundaryMessageId: null,
        retryDelaysMs: [30],
        lifecycleGeneration: staleGeneration,
      });
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(await readAgentWorkflowRunReferences(workspaceSessionDir)).toEqual([]);
    } finally {
      await fs.rm(workspaceSessionDir, { recursive: true, force: true });
    }
  });

  test("a full history clear cancels pending record retries", async () => {
    const workspaceSessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-workflow-runs-"));
    try {
      // A stale detached retry must not resurrect a reference the clear retired; against the
      // then decision-free history it would read current and inject the pre-clear result.
      scheduleAgentWorkflowRunReferenceRecordRetry({
        workspaceSessionDir,
        runId: "wfr_cleared",
        createdAtMs: 1_000,
        afterBoundaryMessageId: null,
        retryDelaysMs: [100],
      });
      await clearAgentWorkflowRunReferences(workspaceSessionDir);
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(await readAgentWorkflowRunReferences(workspaceSessionDir)).toEqual([]);
    } finally {
      await fs.rm(workspaceSessionDir, { recursive: true, force: true });
    }
  });

  test("self-heals unparseable file contents to empty", async () => {
    const workspaceSessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-workflow-runs-"));
    try {
      // Unlike a failed read, corrupted contents cannot be repaired by rereading.
      await fs.writeFile(path.join(workspaceSessionDir, "agent-workflow-runs.json"), "{not json");
      expect(await readAgentWorkflowRunReferences(workspaceSessionDir)).toEqual([]);
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
