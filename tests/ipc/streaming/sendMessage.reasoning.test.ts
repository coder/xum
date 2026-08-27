/**
 * Integration tests for reasoning/thinking functionality on Anthropic Sonnet.
 *
 * Verifies:
 * - Sonnet 4.6 uses effort parameter + adaptive thinking
 * - Sonnet remains stable across multiple thinking levels
 * - Reasoning events are properly streamed
 */

import { shouldRunIntegrationTests, validateApiKeys } from "../setup";
import { sendMessage } from "../helpers";
import {
  createSharedRepo,
  cleanupSharedRepo,
  withSharedWorkspace,
  configureTestRetries,
} from "../sendMessageTestHelpers";
// These tests hit the live Anthropic API, and KNOWN_MODELS.SONNET.id now points at
// claude-sonnet-5-1, which does not exist at the API until Anthropic announces it
// (this PR is prepared ahead of the drop). Pin the last live Sonnet id so the tests
// keep exercising real Sonnet-tier reasoning behavior; flip back to
// KNOWN_MODELS.SONNET.id once Sonnet 5.1 is live.
const LIVE_SONNET_MODEL = "anthropic:claude-sonnet-5";

// Skip all tests if TEST_INTEGRATION is not set
const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

// Validate API keys before running tests
if (shouldRunIntegrationTests()) {
  validateApiKeys(["ANTHROPIC_API_KEY"]);
}

beforeAll(createSharedRepo);
afterAll(cleanupSharedRepo);

describeIntegration("Anthropic reasoning parameter tests", () => {
  configureTestRetries(3);

  test.concurrent(
    "Sonnet 4.6 with thinking (effort + adaptive)",
    async () => {
      await withSharedWorkspace("anthropic", async ({ env, workspaceId, collector }) => {
        const result = await sendMessage(env, workspaceId, "What is 2+2? Answer in one word.", {
          model: LIVE_SONNET_MODEL,
          thinkingLevel: "low",
        });
        expect(result.success).toBe(true);

        await collector.waitForEvent("stream-end", 30000);

        // Verify we got a response
        const deltas = collector.getDeltas();
        expect(deltas.length).toBeGreaterThan(0);
      });
    },
    60000
  );

  test.concurrent(
    "Sonnet 4.6 also supports low-thinking requests",
    async () => {
      await withSharedWorkspace("anthropic", async ({ env, workspaceId, collector }) => {
        const result = await sendMessage(env, workspaceId, "What is 4+4? Answer in one word.", {
          model: LIVE_SONNET_MODEL,
          thinkingLevel: "low",
        });
        expect(result.success).toBe(true);

        await collector.waitForEvent("stream-end", 60000);

        // Verify we got a response
        const deltas = collector.getDeltas();
        expect(deltas.length).toBeGreaterThan(0);
      });
    },
    90000
  );

  test.concurrent(
    "should receive reasoning events when thinking enabled",
    async () => {
      await withSharedWorkspace("anthropic", async ({ env, workspaceId, collector }) => {
        const result = await sendMessage(env, workspaceId, "Explain briefly why 2+2=4", {
          model: LIVE_SONNET_MODEL,
          thinkingLevel: "medium",
        });
        expect(result.success).toBe(true);

        await collector.waitForEvent("stream-end", 45000);

        // Check for reasoning-related events
        const events = collector.getEvents();

        // Should have some delta events
        const deltas = collector.getDeltas();
        expect(deltas.length).toBeGreaterThan(0);

        // May have reasoning events depending on model behavior
        const reasoningStarts = events.filter(
          (e) => "type" in e && (e as { type: string }).type === "reasoning-start"
        );
        const reasoningDeltas = events.filter(
          (e) => "type" in e && (e as { type: string }).type === "reasoning-delta"
        );

        // If we got reasoning events, verify structure
        if (reasoningStarts.length > 0) {
          expect(reasoningDeltas.length).toBeGreaterThan(0);
        }
      });
    },
    60000
  );
});
