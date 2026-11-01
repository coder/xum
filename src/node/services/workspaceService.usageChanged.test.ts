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

describe("WorkspaceService usage-changed", () => {
  test("every usage write emits usage-changed and no activity snapshot", async () => {
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
      const changed: string[] = [];
      const activity: Array<WorkspaceActivitySnapshot | null> = [];
      workspaceService.on("usage-changed", (event) => changed.push(event.workspaceId));
      workspaceService.on("activity", (event) => activity.push(event.activity));

      await sessionUsageService.recordUsage("ws", MODEL, USAGE);
      await sessionUsageService.recordInFlightUsage("ws", "step-key", "message-1", MODEL, USAGE);

      expect(changed).toEqual(["ws", "ws"]);
      // A usage-triggered snapshot read could land after a newer activity emit and resend older
      // activity: usage writes never broadcast activity.
      expect(activity).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});
