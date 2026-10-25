import { setupWorkspace, shouldRunIntegrationTests, validateApiKeys } from "../setup";
import {
  sendMessageWithModel,
  createStreamCollector,
  assertStreamSuccess,
  modelString,
  configureTestRetries,
} from "../helpers";
import {
  ProviderCapacityError,
  isProviderCapacityError,
  retryOnProviderCapacity,
  withProviderCapacityRetryBudget,
} from "./liveProviderCapacity";

// Skip all tests if TEST_INTEGRATION is not set
const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

// Validate API keys before running tests
if (shouldRunIntegrationTests()) {
  validateApiKeys(["OPENAI_API_KEY"]);
}

describeIntegration("OpenAI web_search integration tests", () => {
  // Enable retries in CI for flaky API tests
  configureTestRetries(3);

  test.concurrent(
    "should handle reasoning + web_search without itemId errors",
    async () => {
      await retryOnProviderCapacity("OpenAI reasoning + web_search", async () => {
        // Setup test environment with OpenAI
        const { env, workspaceId, cleanup } = await setupWorkspace("openai");
        const collector = createStreamCollector(env.orpc, workspaceId);
        collector.start();
        try {
          // This prompt reliably triggers the reasoning + web_search bug:
          // 1. Weather search triggers web_search (real-time data)
          // 2. Simple analysis requires reasoning
          // 3. Medium reasoning effort ensures reasoning is present while avoiding excessive loops
          // This combination exposed the itemId bug on main branch
          // Note: Previous prompt (gold price + Collatz) caused excessive tool loops in CI
          const result = await sendMessageWithModel(
            env,
            workspaceId,
            "Use web search to find the current weather in San Francisco. " +
              "Then tell me if it's a good day for a picnic.",
            modelString("openai", "gpt-5.2"),
            {
              thinkingLevel: "medium", // Ensure reasoning without excessive deliberation
            }
          );

          // Verify the IPC call succeeded
          expect(result.success).toBe(true);

          // Wait for the stream to finish (90s should be enough for simple weather + analysis).
          // A stream-error ends the attempt at once: OpenAI's overload response is retried by
          // retryOnProviderCapacity (#5128), and any other error fails in assertStreamSuccess.
          const terminal = await Promise.race([
            collector.waitForEvent("stream-end", 90000),
            collector.waitForEvent("stream-error", 90000),
          ]);
          if (terminal?.type === "stream-error" && isProviderCapacityError(terminal)) {
            throw new ProviderCapacityError(terminal.error);
          }

          // Verify no errors occurred - this is the KEY test
          // Before the fix, this would fail with:
          // "Item 'ws_...' of type 'web_search_call' was provided without its required 'reasoning' item"
          assertStreamSuccess(collector);

          // Get all events and verify both reasoning and web_search occurred
          const events = collector.getEvents();

          // Verify we got reasoning (this is what triggers the bug)
          const hasReasoning = events.some((e) => "type" in e && e.type === "reasoning-delta");

          // Verify web_search was called
          const hasWebSearchCall = events.some(
            (e) =>
              "type" in e &&
              e.type === "tool-call-start" &&
              "toolName" in e &&
              e.toolName === "web_search"
          );

          // Both should be present for this test to be valid
          expect(hasReasoning).toBe(true);
          expect(hasWebSearchCall).toBe(true);

          // Verify we received text deltas (the assistant's final answer)
          const deltas = collector.getDeltas();
          expect(deltas.length).toBeGreaterThan(0);
        } finally {
          collector.stop();
          await cleanup();
        }
      });
    },
    // 120 s per attempt (reasoning + web_search should complete faster with this simpler task),
    // for every capacity attempt plus the waits between them.
    withProviderCapacityRetryBudget(120_000)
  );
});
