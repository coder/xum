import { describe, expect, test } from "bun:test";
import path from "path";
import { createTestHistoryService } from "./testHistoryService";
import { ExtensionMetadataService } from "./ExtensionMetadataService";
import { SessionUsageService } from "./sessionUsageService";
import type { WorkspaceActivitySnapshot } from "@/common/types/workspace";
import { createWorkspaceServiceForTest } from "./workspaceService.testHarness";

const MODEL = "anthropic:claude-sonnet-4-5";
const USAGE = {
  input: { tokens: 10 },
  output: { tokens: 5 },
  cached: { tokens: 0 },
  cacheCreate: { tokens: 0 },
  reasoning: { tokens: 0 },
};

describe("WorkspaceService usage revision", () => {
  test("a usage write emits a usage-revision event, not an activity snapshot, and lists it", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: "ws",
        name: "ws",
        projectPath,
        projectName: "project",
        runtimeConfig: { type: "local" },
      });
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      await extensionMetadata.updateRecency("ws", 1);
      const sessionUsageService = new SessionUsageService(config, historyService);
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        extensionMetadata,
        sessionUsageService,
      });
      expect((await workspaceService.getActivityList())?.ws?.usageRevision).toBeUndefined();
      const revisions: number[] = [];
      const activity: Array<WorkspaceActivitySnapshot | null> = [];
      workspaceService.on("usage-revision", (event) => {
        if (event.workspaceId === "ws") revisions.push(event.usageRevision);
      });
      workspaceService.on("activity", (event) => activity.push(event.activity));

      await sessionUsageService.recordUsage("ws", MODEL, USAGE);
      expect(revisions).toHaveLength(1);
      expect((await workspaceService.getActivityList())?.ws?.usageRevision).toBe(revisions[0]);

      await sessionUsageService.recordInFlightUsage("ws", "step-key", "message-1", MODEL, USAGE);
      expect(revisions).toHaveLength(2);
      expect(revisions[1]).toBeGreaterThan(revisions[0]);
      // A snapshot read for a usage move could land after a newer activity emit and resend
      // older activity: usage moves never broadcast activity.
      expect(activity).toEqual([]);

      // A late usage write after removal announces nothing for the removed id.
      await extensionMetadata.deleteWorkspace("ws");
      await sessionUsageService.recordUsage("ws", MODEL, USAGE);
      expect(revisions).toHaveLength(2);
    } finally {
      await cleanup();
    }
  });
});
