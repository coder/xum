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

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(condition()).toBe(true);
}

describe("WorkspaceService usage revision", () => {
  test("a usage write moves the revision on emitted and listed activity", async () => {
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
      const emitted: Array<WorkspaceActivitySnapshot | null> = [];
      workspaceService.on("activity", (event) => {
        if (event.workspaceId === "ws") emitted.push(event.activity);
      });

      await sessionUsageService.recordUsage("ws", MODEL, USAGE);
      await waitFor(() => emitted.length === 1);
      const first = emitted[0]?.usageRevision;
      expect(first).toBeNumber();
      expect((await workspaceService.getActivityList())?.ws?.usageRevision).toBe(first);

      await sessionUsageService.recordInFlightUsage("ws", "step-key", "message-1", MODEL, USAGE);
      await waitFor(() => emitted.length === 2);
      expect(emitted[1]?.usageRevision).toBeGreaterThan(first!);
    } finally {
      await cleanup();
    }
  });
});
