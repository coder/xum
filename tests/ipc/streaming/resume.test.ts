import { setupWorkspace, shouldRunIntegrationTests, validateApiKeys } from "../setup";
import {
  sendMessageWithModel,
  createStreamCollector,
  HAIKU_MODEL,
  resolveOrpcClient,
  configureTestRetries,
} from "../helpers";
import { HistoryService } from "../../../src/node/services/historyService";
import { createMuxMessage } from "../../../src/common/types/message";
import type { WorkspaceChatMessage } from "@/common/orpc/types";

// Skip all tests if TEST_INTEGRATION is not set
const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

// Validate API keys before running tests
if (shouldRunIntegrationTests()) {
  validateApiKeys(["ANTHROPIC_API_KEY"]);
}

const RESUME_STREAM_MODEL = HAIKU_MODEL;
// Resume behavior is model-agnostic, so keep this coverage on fast Haiku.

describeIntegration("resumeStream", () => {
  // Enable retries in CI for flaky API tests
  configureTestRetries(3);

  test.concurrent(
    "should resume interrupted stream without new user message",
    async () => {
      const { env, workspaceId, cleanup } = await setupWorkspace("anthropic");
      const collector1 = createStreamCollector(env.orpc, workspaceId);
      collector1.start();
      // Wait until the onChat subscription is fully established before sending.
      // Without this guard, the initial history replay can race with the live user
      // message append and emit the same user message twice in collector1.
      await collector1.waitForSubscription(10000);

      try {
        // Ensure the onChat subscription has finished history replay before we send a new message.
        // Otherwise the user message can appear twice (once from live events, once from replay).
        await collector1.waitForSubscription(5000);

        // Start a stream with a bash command that outputs a specific word
        const expectedWord = "RESUMPTION_TEST_SUCCESS";
        void sendMessageWithModel(
          env,
          workspaceId,
          `Use bash to run: for i in {1..10}; do sleep 0.5; done && echo '${expectedWord}'. Set display_name="resume-test" and timeout_secs=120. Do not spawn a sub-agent.`,
          RESUME_STREAM_MODEL,
          {
            toolPolicy: [{ regex_match: "bash", action: "require" }],
          }
        );

        // Wait for stream to start
        const streamStartEvent = await collector1.waitForEvent("stream-start", 5000);
        expect(streamStartEvent).toBeDefined();

        // Wait for at least some content or tool call
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Interrupt the stream with interruptStream()
        const client = resolveOrpcClient(env);
        const interruptResult = await client.workspace.interruptStream({ workspaceId });
        expect(interruptResult.success).toBe(true);

        // Wait for stream to be interrupted (abort or end event)
        const abortOrEnd = await Promise.race([
          collector1.waitForEvent("stream-abort", 5000),
          collector1.waitForEvent("stream-end", 5000),
        ]);
        expect(abortOrEnd).toBeDefined();

        // Count user messages before resume (should be 1)
        const userMessagesBefore = collector1
          .getEvents()
          .filter((e: WorkspaceChatMessage) => "role" in e && e.role === "user");
        expect(userMessagesBefore.length).toBe(1);
        collector1.stop();

        // Create a new collector for resume events
        const collector2 = createStreamCollector(env.orpc, workspaceId);
        collector2.start();

        // Wait for history replay to complete (caught-up event)
        await collector2.waitForEvent("caught-up", 5000);

        // Count user messages from history replay (should be 1 - the original message)
        const userMessagesFromReplay = collector2
          .getEvents()
          .filter((e: WorkspaceChatMessage) => "role" in e && e.role === "user");
        expect(userMessagesFromReplay.length).toBe(1);

        // Resume the stream (no new user message)
        const resumeResult = await client.workspace.resumeStream({
          workspaceId,
          options: { model: RESUME_STREAM_MODEL, agentId: "exec" },
        });
        expect(resumeResult.success).toBe(true);

        // Wait for new stream to start
        const resumeStreamStart = await collector2.waitForEvent("stream-start", 5000);
        expect(resumeStreamStart).toBeDefined();

        // Wait for stream to complete
        const streamEnd = await collector2.waitForEvent("stream-end", 30000);
        expect(streamEnd).toBeDefined();

        // Verify no NEW user message was created after resume (total should still be 1)
        const userMessagesAfter = collector2
          .getEvents()
          .filter((e: WorkspaceChatMessage) => "role" in e && e.role === "user");
        expect(userMessagesAfter.length).toBe(1); // Still only the original user message

        // Verify stream completed successfully (without errors)
        const streamErrors = collector2
          .getEvents()
          .filter((e: WorkspaceChatMessage) => "type" in e && e.type === "stream-error");
        expect(streamErrors.length).toBe(0);

        // Verify we received stream deltas (actual content)
        const deltas = collector2.getDeltas();
        expect(deltas.length).toBeGreaterThan(0);

        // Verify the stream-end event is present and well-formed
        expect(streamEnd).toBeDefined();
        if (streamEnd && "messageId" in streamEnd && "historySequence" in streamEnd) {
          expect(streamEnd.messageId).toBeTruthy();
          expect(streamEnd.historySequence).toBeGreaterThan(0);
        }

        // Verify we received the expected word in the output
        // This proves the bash command completed successfully after resume
        const allText = deltas
          .filter((d: WorkspaceChatMessage) => "delta" in d)
          .map((d: WorkspaceChatMessage) => ("delta" in d ? (d as { delta: string }).delta : ""))
          .join("");
        expect(allText).toContain(expectedWord);
        collector2.stop();
      } finally {
        await cleanup();
      }
    },
    45000 // 45 second timeout for this test
  );

  test.concurrent(
    "should resume from single assistant message (post-compaction scenario)",
    async () => {
      const { env, workspaceId, cleanup } = await setupWorkspace("anthropic");
      const collector = createStreamCollector(env.orpc, workspaceId);
      collector.start();
      try {
        // Create a history service to write directly to chat.jsonl
        const historyService = new HistoryService(env.config);

        // Simulate post-compaction state: single assistant message with summary
        // The message promises to say a specific word next, allowing deterministic verification
        const verificationWord = "ELEPHANT";
        const summaryMessage = createMuxMessage(
          "compaction-summary-msg",
          "assistant",
          `I previously helped with a task. The conversation has been compacted for token efficiency. My next message will contain the word ${verificationWord} to confirm continuation works correctly.`,
          {
            compacted: true,
          }
        );

        // Write the summary message to history
        const appendResult = await historyService.appendToHistory(workspaceId, summaryMessage);
        expect(appendResult.success).toBe(true);

        // Wait a moment for events to settle
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Resume the stream (should continue from the summary message)
        const client = resolveOrpcClient(env);
        const resumeResult = await client.workspace.resumeStream({
          workspaceId,
          options: { model: RESUME_STREAM_MODEL, agentId: "exec" },
        });
        expect(resumeResult.success).toBe(true);

        // Wait for stream to start
        const streamStart = await collector.waitForEvent("stream-start", 10000);
        expect(streamStart).toBeDefined();

        // Wait for stream to complete
        const streamEnd = await collector.waitForEvent("stream-end", 30000);
        expect(streamEnd).toBeDefined();

        // Verify no visible user message was created (resumeStream should not add one). The
        // backend publishes its persisted hidden [CONTINUE] sentinel (synthetic, filtered from
        // display) so edit fences count the same rows on client and server.
        const userMessages = collector
          .getEvents()
          .filter(
            (e: WorkspaceChatMessage) =>
              "role" in e &&
              e.role === "user" &&
              !("metadata" in e && e.metadata?.synthetic === true)
          );
        expect(userMessages.length).toBe(0);

        // Verify we received content deltas (the actual assistant response during streaming)
        const deltas = collector.getDeltas();
        expect(deltas.length).toBeGreaterThan(0);

        // Verify no stream errors
        const streamErrors = collector
          .getEvents()
          .filter((e: WorkspaceChatMessage) => "type" in e && e.type === "stream-error");
        expect(streamErrors.length).toBe(0);

        // Verify the assistant responded with actual content and said the verification word
        const allText = deltas
          .filter((d: WorkspaceChatMessage) => "delta" in d)
          .map((d: WorkspaceChatMessage) => ("delta" in d ? (d as { delta: string }).delta : ""))
          .join("");
        expect(allText.length).toBeGreaterThan(0);

        // Verify the assistant followed the instruction and said the verification word
        // This proves resumeStream properly loaded history and continued from it
        expect(allText).toContain(verificationWord);
        collector.stop();
      } finally {
        await cleanup();
      }
    },
    45000 // 45 second timeout for this test
  );
});
