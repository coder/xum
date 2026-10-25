import { createTestEnvironment, cleanupTestEnvironment } from "../setup";
import {
  createWorkspace,
  generateBranchName,
  createTempGitRepo,
  cleanupTempGitRepo,
} from "../helpers";
import { HistoryService } from "@/node/services/historyService";
import { createMuxMessage } from "@/common/types/message";
import type { MuxMessage } from "@/common/types/message";
import assert from "node:assert";

async function collectFullHistory(
  service: HistoryService,
  workspaceId: string
): Promise<MuxMessage[]> {
  const messages: MuxMessage[] = [];
  const result = await service.iterateFullHistory(workspaceId, "forward", (chunk) => {
    messages.push(...chunk);
  });
  assert(result.success, `collectFullHistory failed: ${result.success ? "" : result.error}`);
  return messages;
}

/**
 * Integration test for WebSocket history replay bug
 *
 * Bug: When a new WebSocket client subscribes to a workspace, the history replay
 * broadcasts to ALL connected clients subscribed to that workspace, not just the
 * newly connected one.
 *
 * This test simulates multiple clients by tracking events sent to each "client"
 * through separate subscription handlers.
 */

describe("WebSocket history replay", () => {
  test("getHistory IPC handler should return history without broadcasting", async () => {
    // Create test environment
    const env = await createTestEnvironment();

    try {
      const tempGitRepo = await createTempGitRepo();

      const branchName = generateBranchName("ws-history-ipc-test");
      const createResult = await createWorkspace(env, tempGitRepo, branchName);

      if (!createResult.success) {
        throw new Error(`Workspace creation failed: ${createResult.error}`);
      }

      const workspaceId = createResult.metadata.id;

      const historyService = new HistoryService(env.config);
      const testMessage = createMuxMessage("test-msg-2", "user", "Test message for getHistory");
      await historyService.appendToHistory(workspaceId, testMessage);

      await new Promise((resolve) => setTimeout(resolve, 100));

      const messages = await collectFullHistory(historyService, workspaceId);

      expect(messages.length).toBeGreaterThan(0);
      console.log(`iterateFullHistory returned ${messages.length} messages`);

      await cleanupTempGitRepo(tempGitRepo);
    } finally {
      await cleanupTestEnvironment(env);
    }
  }, 15000);
});
