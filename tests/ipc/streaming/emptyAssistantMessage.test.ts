/**
 * Test that corrupted chat history with empty assistant messages
 * does not brick the workspace (self-healing behavior).
 *
 * Reproduction of: "messages.95: all messages must have non-empty content
 * except for the optional final assistant message"
 */
import { setupWorkspace, shouldRunIntegrationTests, validateApiKeys } from "../setup";
import { sendMessageWithModel, createStreamCollector, HAIKU_MODEL } from "../helpers";
import { HistoryService } from "../../../src/node/services/historyService";
import { createMuxMessage } from "../../../src/common/types/message";

// Skip all tests if TEST_INTEGRATION is not set
const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

// Validate API keys before running tests
if (shouldRunIntegrationTests()) {
  validateApiKeys(["ANTHROPIC_API_KEY"]);
}

describeIntegration("empty assistant message self-healing", () => {
  test.concurrent(
    "should handle corrupted history with empty assistant parts array",
    async () => {
      const { env, workspaceId, cleanup } = await setupWorkspace("anthropic");
      try {
        const historyService = new HistoryService(env.config);

        // Seed history that mimics a crash-corrupted chat.jsonl:
        // 1. User message
        // 2. Assistant message with content
        // 3. User follow-up
        // 4. Empty assistant message (crash during stream start - placeholder persisted)
        const messages = [
          createMuxMessage("msg-1", "user", "Hello", {}),
          createMuxMessage("msg-2", "assistant", "Hi there!", {}),
          createMuxMessage("msg-3", "user", "Follow up question", {}),
          // Corrupted: empty parts array (placeholder message from crash)
          {
            id: "msg-4-corrupted",
            role: "assistant" as const,
            parts: [], // Empty - this is the corruption
            metadata: {
              timestamp: Date.now(),
              model: HAIKU_MODEL,
              mode: "exec" as const,
              historySequence: 3,
            },
          },
        ];

        // Write corrupted history directly
        for (const msg of messages) {
          const result = await historyService.appendToHistory(workspaceId, msg);
          if (!result.success) {
            throw new Error(`Failed to seed history: ${result.error}`);
          }
        }

        // Now try to send a new message - this should NOT fail with
        // "all messages must have non-empty content"
        const collector = createStreamCollector(env.orpc, workspaceId);
        collector.start();

        const sendResult = await sendMessageWithModel(
          env,
          workspaceId,
          "This should work despite corrupted history",
          HAIKU_MODEL
        );

        // The send should succeed (not fail due to corrupted history)
        expect(sendResult.success).toBe(true);

        // Wait for stream to complete successfully
        const streamEnd = await collector.waitForEvent("stream-end", 30000);
        expect(streamEnd).toBeDefined();

        collector.stop();
      } finally {
        await cleanup();
      }
    },
    60000
  );

  test.concurrent(
    "should handle corrupted history with incomplete tool-only assistant message",
    async () => {
      const { env, workspaceId, cleanup } = await setupWorkspace("anthropic");
      try {
        const historyService = new HistoryService(env.config);

        // Seed history with an assistant message that has only an incomplete tool call
        // (state: "input-available" means tool was requested but never executed)
        const messages = [
          createMuxMessage("msg-1", "user", "Run a command", {}),
          // Corrupted: tool-only with incomplete state
          {
            id: "msg-2-corrupted",
            role: "assistant" as const,
            parts: [
              {
                type: "dynamic-tool" as const,
                toolName: "bash",
                toolCallId: "call-123",
                state: "input-available" as const, // Incomplete - will be dropped by SDK
                input: { script: "echo hello" },
              },
            ],
            metadata: {
              timestamp: Date.now(),
              model: HAIKU_MODEL,
              mode: "exec" as const,
              historySequence: 1,
            },
          },
        ];

        // Write corrupted history directly
        for (const msg of messages) {
          const result = await historyService.appendToHistory(workspaceId, msg);
          if (!result.success) {
            throw new Error(`Failed to seed history: ${result.error}`);
          }
        }

        // Now try to send a new message
        const collector = createStreamCollector(env.orpc, workspaceId);
        collector.start();

        const sendResult = await sendMessageWithModel(
          env,
          workspaceId,
          "This should work despite corrupted tool history",
          HAIKU_MODEL
        );

        expect(sendResult.success).toBe(true);

        const streamEnd = await collector.waitForEvent("stream-end", 30000);
        expect(streamEnd).toBeDefined();

        collector.stop();
      } finally {
        await cleanup();
      }
    },
    60000
  );
});
