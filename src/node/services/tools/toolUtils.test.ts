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
});
