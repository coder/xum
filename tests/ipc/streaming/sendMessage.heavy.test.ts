/**
 * sendMessage heavy/load integration tests.
 *
 * Tests heavy workload scenarios:
 * - Large message handling
 * - Context limit error handling
 */

import { shouldRunIntegrationTests, validateApiKeys } from "../setup";
import { sendMessageWithModel, modelString } from "../helpers";
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

beforeAll(createSharedRepo);
afterAll(cleanupSharedRepo);

describeIntegration("sendMessage heavy/load tests", () => {
  configureTestRetries(3);

  describe("OpenAI context limit error (forced)", () => {
    const provider = "openai";
    const model = KNOWN_MODELS.GPT.providerModelId;

    test.concurrent(
      "should emit context_exceeded when forceContextLimitError is set",
      async () => {
        await withSharedWorkspace(provider, async ({ env, workspaceId, collector }) => {
          const result = await sendMessageWithModel(
            env,
            workspaceId,
            "Trigger a forced context limit error",
            modelString(provider, model),
            {
              providerOptions: {
                openai: {
                  forceContextLimitError: true,
                },
              },
            }
          );

          expect(result.success).toBe(true);

          const errorEvent = await collector.waitForEvent("stream-error", 30000);
          expect(errorEvent).not.toBeNull();
          if (errorEvent?.type !== "stream-error") {
            throw new Error("Expected stream-error event");
          }

          expect(errorEvent.errorType).toBe("context_exceeded");
          expect(errorEvent.error.toLowerCase()).toContain("context");
        });
      },
      45000
    );
  });

  describe("context limit handling", () => {
    test.concurrent(
      "should handle very long single messages",
      async () => {
        await withSharedWorkspace("openai", async ({ env, workspaceId, collector }) => {
          // Send a very long message
          const longContent = "This is a test message. ".repeat(1000);
          const result = await sendMessageWithModel(
            env,
            workspaceId,
            longContent,
            modelString("openai", KNOWN_MODELS.GPT.providerModelId)
          );

          expect(result.success).toBe(true);

          // Should complete or error gracefully
          await Promise.race([
            collector.waitForEvent("stream-end", 30000),
            collector.waitForEvent("stream-error", 30000),
          ]);

          // Either way, should have received some response
          const events = collector.getEvents();
          expect(events.length).toBeGreaterThan(0);
        });
      },
      45000
    );
  });
});
