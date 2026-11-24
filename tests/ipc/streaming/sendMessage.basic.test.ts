/**
 * Basic sendMessage integration tests.
 *
 * Tests core message sending functionality:
 * - Successful message send and response
 * - Stream interruption
 * - Token tracking
 * - Provider parity (OpenAI and Anthropic)
 */

import { shouldRunIntegrationTests, validateApiKeys } from "../setup";
import { sendMessageWithModel, modelString, assertStreamSuccess } from "../helpers";
import {
  createSharedRepo,
  cleanupSharedRepo,
  withSharedWorkspace,
  configureTestRetries,
} from "../sendMessageTestHelpers";
import { KNOWN_MODELS } from "../../../src/common/constants/knownModels";

// Skip all tests if TEST_INTEGRATION is not set
const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

// Validate API keys before running tests
if (shouldRunIntegrationTests()) {
  validateApiKeys(["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]);
}

// Test both providers with their respective models
const PROVIDER_CONFIGS: [string, string][] = [
  ["openai", KNOWN_MODELS.GPT.providerModelId],
  ["anthropic", KNOWN_MODELS.HAIKU.providerModelId],
];

// Integration test timeout guidelines:
// - Individual tests should complete within 10 seconds when possible
// - Use tight timeouts (5-10s) for event waiting to fail fast
// - Longer running tests (tool calls, multiple edits) can take up to 30s
// - Test timeout values should be 2-3x the expected duration

beforeAll(createSharedRepo);
afterAll(cleanupSharedRepo);

describeIntegration("sendMessage basic integration tests", () => {
  configureTestRetries(3);

  // Run tests for each provider concurrently
  describe.each(PROVIDER_CONFIGS)("%s provider tests", (provider, model) => {
    test.concurrent(
      "should successfully send message and receive response",
      async () => {
        await withSharedWorkspace(provider, async ({ env, workspaceId, collector }) => {
          // Send a simple message
          const result = await sendMessageWithModel(
            env,
            workspaceId,
            "Say 'hello' and nothing else",
            modelString(provider, model)
          );

          // Verify the call succeeded
          expect(result.success).toBe(true);

          // Wait for stream to complete
          await collector.waitForEvent("stream-end", 15000);

          // Verify stream was successful
          assertStreamSuccess(collector);

          // Verify we received content
          const deltas = collector.getDeltas();
          expect(deltas.length).toBeGreaterThan(0);
        });
      },
      20000
    );

    test.concurrent(
      "should interrupt streaming with interruptStream()",
      async () => {
        await withSharedWorkspace(provider, async ({ env, workspaceId, collector }) => {
          // Start a message that would generate a long response
          const longMessage =
            "Write a very long essay about the history of computing, at least 1000 words.";
          void sendMessageWithModel(env, workspaceId, longMessage, modelString(provider, model));

          // Wait for stream to start
          await collector.waitForEvent("stream-start", 10000);

          // Give it a moment to start streaming
          await new Promise((resolve) => setTimeout(resolve, 500));

          // Interrupt the stream
          const interruptResult = await env.orpc.workspace.interruptStream({ workspaceId });
          expect(interruptResult.success).toBe(true);

          // Wait for stream-abort event
          const abortEvent = await collector.waitForEvent("stream-abort", 5000);
          expect(abortEvent).toBeDefined();
        });
      },
      20000
    );

    test.concurrent(
      "should track usage tokens",
      async () => {
        await withSharedWorkspace(provider, async ({ env, workspaceId, collector }) => {
          // Send a message
          const result = await sendMessageWithModel(
            env,
            workspaceId,
            "Say 'test' and nothing else",
            modelString(provider, model)
          );

          expect(result.success).toBe(true);

          // Wait for stream to complete
          await collector.waitForEvent("stream-end", 15000);

          // Check for usage-delta events
          const events = collector.getEvents();
          const usageEvents = events.filter(
            (e) => "type" in e && (e as { type: string }).type === "usage-delta"
          );

          // Should have at least one usage event
          expect(usageEvents.length).toBeGreaterThan(0);
        });
      },
      20000
    );

    test.concurrent(
      "should handle multiple sequential messages",
      async () => {
        await withSharedWorkspace(provider, async ({ env, workspaceId, collector }) => {
          // Send first message
          const result1 = await sendMessageWithModel(
            env,
            workspaceId,
            "Say 'one'",
            modelString(provider, model)
          );
          expect(result1.success).toBe(true);

          // Wait for first stream to complete
          await collector.waitForEvent("stream-end", 15000);

          // Small delay to allow stream cleanup to complete before sending next message
          await new Promise((resolve) => setTimeout(resolve, 100));

          // Clear collector for next message
          collector.clear();

          // Send second message
          const result2 = await sendMessageWithModel(
            env,
            workspaceId,
            "Say 'two'",
            modelString(provider, model)
          );
          expect(result2.success).toBe(true);

          // Wait for second stream to complete
          await collector.waitForEvent("stream-end", 15000);

          // Verify both completed successfully
          assertStreamSuccess(collector);
        });
      },
      30000
    );
  });

  // Cross-provider tests
  test.concurrent(
    "should work with both providers in same workspace",
    async () => {
      await withSharedWorkspace("openai", async ({ env, workspaceId, collector }) => {
        // Send with OpenAI
        const openaiResult = await sendMessageWithModel(
          env,
          workspaceId,
          "Say 'openai'",
          modelString("openai", KNOWN_MODELS.GPT.providerModelId)
        );
        expect(openaiResult.success).toBe(true);
        await collector.waitForEvent("stream-end", 15000);

        // Setup Anthropic provider
        const { setupProviders } = await import("../setup");
        const { getApiKey } = await import("../../testUtils");
        await setupProviders(env, {
          anthropic: { apiKey: getApiKey("ANTHROPIC_API_KEY") },
        });

        collector.clear();

        // Send with Anthropic
        const anthropicResult = await sendMessageWithModel(
          env,
          workspaceId,
          "Say 'anthropic'",
          modelString("anthropic", KNOWN_MODELS.HAIKU.providerModelId)
        );
        expect(anthropicResult.success).toBe(true);
        await collector.waitForEvent("stream-end", 15000);
      });
    },
    40000
  );
});
