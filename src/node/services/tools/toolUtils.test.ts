import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";

import type { ToolConfiguration } from "@/common/utils/tools/tools";
import {
  readAgentWorkflowRunReferences,
  recordAgentWorkflowRunReference,
} from "@/node/services/agentWorkflowRunReferences";
import { recordBackgroundWorkflowRunReference } from "@/node/services/tools/toolUtils";

describe("recordBackgroundWorkflowRunReference", () => {
  test("retries a failed provenance record until storage recovers", async () => {
    const workspaceSessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "toolutils-record-"));
    try {
      await recordAgentWorkflowRunReference({
        workspaceSessionDir,
        runId: "wfr_existing",
        createdAtMs: 1_000,
      });
      const filePath = path.join(workspaceSessionDir, "agent-workflow-runs.json");
      // Unreadable at record time: the tool has already returned by the time storage recovers,
      // and an untouched active run never hits a natural re-record site, so only the bounded
      // background retry can persist provenance for the terminal wake.
      await fs.chmod(filePath, 0o000);
      await recordBackgroundWorkflowRunReference(
        { workspaceSessionDir } as unknown as ToolConfiguration,
        "wfr_retry",
        2_000,
        [25, 25, 25]
      );
      await fs.chmod(filePath, 0o600);

      const deadline = Date.now() + 5_000;
      let runIds: string[] = [];
      while (Date.now() < deadline) {
        runIds = (await readAgentWorkflowRunReferences(workspaceSessionDir)).map(
          (reference) => reference.runId
        );
        if (runIds.includes("wfr_retry")) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(new Set(runIds)).toEqual(new Set(["wfr_existing", "wfr_retry"]));
    } finally {
      await fs.rm(workspaceSessionDir, { recursive: true, force: true });
    }
  });

  test("repairs a verified-empty boundary snapshot after a transient read failure", async () => {
    const workspaceSessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "toolutils-boundary-"));
    try {
      // Launch from a decision-free history whose boundary read fails once: the rediscovery
      // entry lands boundary-less, and only the repair can restore the verified-empty (null)
      // snapshot the decision-free currentness branch requires.
      let calls = 0;
      const taskService = {
        getWorkflowInvocationBoundaryMessageId: (): Promise<string | null> => {
          calls += 1;
          return calls === 1
            ? Promise.reject(new Error("history unavailable"))
            : Promise.resolve(null);
        },
      };
      await recordBackgroundWorkflowRunReference(
        {
          workspaceSessionDir,
          workspaceId: "ws-boundary-repair",
          taskService,
        } as unknown as ToolConfiguration,
        "wfr_boundary_repair",
        2_000,
        [25, 25, 25]
      );
      let reference: { afterBoundaryMessageId?: string | null } | undefined;
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        [reference] = await readAgentWorkflowRunReferences(workspaceSessionDir);
        if (reference?.afterBoundaryMessageId === null) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(reference).toMatchObject({
        runId: "wfr_boundary_repair",
        afterBoundaryMessageId: null,
      });
    } finally {
      await fs.rm(workspaceSessionDir, { recursive: true, force: true });
    }
  });

  test("boundary repair waits for the record retry to land the entry", async () => {
    const workspaceSessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "toolutils-boundary-"));
    try {
      // Both the boundary read AND the initial sidecar write fail: the reference does not
      // exist when the repair first fires. A missing entry must stay retryable, or the record
      // retry that lands later creates a permanently boundary-less reference.
      let calls = 0;
      const taskService = {
        getWorkflowInvocationBoundaryMessageId: (): Promise<string | null> => {
          calls += 1;
          return calls === 1
            ? Promise.reject(new Error("history unavailable"))
            : Promise.resolve(null);
        },
      };
      const filePath = path.join(workspaceSessionDir, "agent-workflow-runs.json");
      await recordAgentWorkflowRunReference({
        workspaceSessionDir,
        runId: "wfr_seed",
        createdAtMs: 1_000,
      });
      await fs.chmod(filePath, 0o000);
      await recordBackgroundWorkflowRunReference(
        {
          workspaceSessionDir,
          workspaceId: "ws-boundary-late",
          taskService,
        } as unknown as ToolConfiguration,
        "wfr_boundary_late",
        2_000,
        [40, 40, 40, 40, 40]
      );
      // Storage recovers only after the repair has fired at least once against the missing
      // entry; the record retry then lands it and a later repair attempt patches null.
      await new Promise((resolve) => setTimeout(resolve, 60));
      await fs.chmod(filePath, 0o600);

      const deadline = Date.now() + 5_000;
      let boundary: string | null | undefined;
      while (Date.now() < deadline) {
        boundary = (await readAgentWorkflowRunReferences(workspaceSessionDir)).find(
          (reference) => reference.runId === "wfr_boundary_late"
        )?.afterBoundaryMessageId;
        if (boundary === null) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(boundary).toBe(null);
    } finally {
      await fs.rm(workspaceSessionDir, { recursive: true, force: true });
    }
  });

  test("keeps the entry boundary-less when a decision row exists at repair time", async () => {
    const workspaceSessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "toolutils-boundary-"));
    try {
      // A decision row seen at repair time may postdate the launch; persisting it would
      // overclaim currentness, so the entry must stay boundary-less and fail safe.
      let calls = 0;
      const taskService = {
        getWorkflowInvocationBoundaryMessageId: (): Promise<string | null> => {
          calls += 1;
          return calls === 1
            ? Promise.reject(new Error("history unavailable"))
            : Promise.resolve("manual-user");
        },
      };
      await recordBackgroundWorkflowRunReference(
        {
          workspaceSessionDir,
          workspaceId: "ws-boundary-unsafe",
          taskService,
        } as unknown as ToolConfiguration,
        "wfr_boundary_unsafe",
        2_000,
        [25]
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      const references = await readAgentWorkflowRunReferences(workspaceSessionDir);
      expect(references).toHaveLength(1);
      expect(references[0]?.runId).toBe("wfr_boundary_unsafe");
      expect(references[0]?.afterBoundaryMessageId).toBeUndefined();
    } finally {
      await fs.rm(workspaceSessionDir, { recursive: true, force: true });
    }
  });
});
