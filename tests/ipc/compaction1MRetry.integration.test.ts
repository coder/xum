/**
 * Integration test: Compaction 1M context retry.
 *
 * Validates that when a /compact request exceeds the default context limit (200k),
 * the backend automatically retries with 1M context enabled for models that support it.
 *
 * Pre-seeds ~250k tokens of conversation history, then issues a compaction request
 * with an explicitly pinned Sonnet integration model (default 200k limit, supports 1M).
 * If the 1M retry fires correctly, the compaction should succeed rather than
 * returning context_exceeded.
 */

import { setupWorkspace, shouldRunIntegrationTests, validateApiKeys } from "./setup";
import { createStreamCollector, resolveOrpcClient } from "./helpers";
import { HistoryService } from "../../src/node/services/historyService";
import { createMuxMessage } from "../../src/common/types/message";

// Skip all tests if TEST_INTEGRATION is not set
const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

if (shouldRunIntegrationTests()) {
  validateApiKeys(["ANTHROPIC_API_KEY"]);
}

// ~1 token ≈ 4 chars in English text. To exceed 200k tokens we need ~800k chars.
// Use ~260k tokens of padding to comfortably exceed the 200k default context.
const TOKENS_PER_CHAR = 0.25; // conservative estimate
const TARGET_TOKENS = 260_000;
const CHARS_NEEDED = Math.ceil(TARGET_TOKENS / TOKENS_PER_CHAR);

const FILLER_FILES = [
  "src/config.ts",
  "src/node/services/historyService.ts",
  "src/browser/components/ChatInput.tsx",
  "src/common/utils/tokens.ts",
  "src/node/runtime/LocalRuntime.ts",
  "docs/workspaces.mdx",
  "tests/ipc/setup.ts",
  "Makefile",
];
const FILLER_ACTIONS = [
  "Reviewed the error handling in",
  "Added a unit test covering an empty input for",
  "Renamed a local variable for clarity in",
  "Documented the default timeout in",
  "Simplified a nested conditional in",
  "Fixed a typo in a log message in",
  "Moved a shared constant out of",
  "Checked the null handling in",
];
const FILLER_OUTCOMES = [
  "the type checker reported no errors",
  "all unit tests passed",
  "the linter reported no warnings",
  "the reviewer approved the change",
  "the build finished without warnings",
  "no behavior changed",
];

/**
 * Build deterministic, non-repetitive filler that reads like an ordinary coding-session log.
 *
 * Repeating one pangram paragraph ~20k times started ending the stream with a provider
 * content-filter refusal (issue #4398). Varied, benign engineering notes keep the request
 * realistic for a /compact summary while still exceeding the 200k default context window.
 */
function buildFillerText(charCount: number, seed: number): string {
  // Small LCG so every run sends identical bytes (reproducible failures) without repetition.
  let state = (seed + 1) >>> 0;
  const pick = <T>(items: readonly T[]): T => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    // High bits: the low bits of a power-of-two LCG cycle with a tiny period.
    return items[(state >>> 16) % items.length];
  };
  const sentences: string[] = [];
  let length = 0;
  for (let step = 1; length < charCount; step += 1) {
    const line = 1 + ((state >>> 8) % 900);
    const sentence =
      `Note ${seed}.${step}: ${pick(FILLER_ACTIONS)} ${pick(FILLER_FILES)} near line ${line}; ` +
      `afterwards ${pick(FILLER_OUTCOMES)}.\n`;
    sentences.push(sentence);
    length += sentence.length;
  }
  return sentences.join("").slice(0, charCount);
}

const COMPACTION_1M_RETRY_MODEL = "anthropic:claude-sonnet-4-6";
const ANTHROPIC_OVERLOAD_MESSAGE = "Anthropic is temporarily overloaded (HTTP 529)";
const MAX_PROVIDER_OVERLOAD_ATTEMPTS = process.env.CI ? 3 : 1;
const PROVIDER_OVERLOAD_BACKOFF_MS = 2_000;
const SUBSCRIPTION_SETUP_TIMEOUT_MS = 5_000;
const TOTAL_PROVIDER_OVERLOAD_BACKOFF_MS =
  (PROVIDER_OVERLOAD_BACKOFF_MS *
    ((MAX_PROVIDER_OVERLOAD_ATTEMPTS - 1) * MAX_PROVIDER_OVERLOAD_ATTEMPTS)) /
  2;
// Pinned to Sonnet: this test validates 1M-context retry behavior; Haiku's context window is too small

describeIntegration("compaction 1M context retry", () => {
  // Compaction with 1M retry can take a while — summarizing 250k+ tokens of content.
  // When Anthropic is overloaded in CI, allow a few retries within the same test before
  // treating the result as inconclusive rather than failing the whole PR on provider flakiness.
  const TEST_TIMEOUT_MS = 180_000;
  const TEST_TIMEOUT_BUDGET_MS =
    TEST_TIMEOUT_MS * MAX_PROVIDER_OVERLOAD_ATTEMPTS +
    SUBSCRIPTION_SETUP_TIMEOUT_MS * MAX_PROVIDER_OVERLOAD_ATTEMPTS +
    TOTAL_PROVIDER_OVERLOAD_BACKOFF_MS +
    10_000;

  test(
    "should auto-retry compaction with 1M context when exceeding 200k default limit",
    async () => {
      const { env, workspaceId, cleanup } = await setupWorkspace("anthropic");
      try {
        const historyService = new HistoryService(env.config);

        // Seed conversation history that exceeds 200k tokens.
        // Split across multiple user/assistant pairs to be realistic.
        const pairsNeeded = 10;
        const charsPerMessage = Math.ceil(CHARS_NEEDED / pairsNeeded);

        for (let i = 0; i < pairsNeeded; i++) {
          const userMsg = createMuxMessage(
            `filler-user-${i}`,
            "user",
            buildFillerText(charsPerMessage, 2 * i),
            {}
          );
          const assistantMsg = createMuxMessage(
            `filler-asst-${i}`,
            "assistant",
            buildFillerText(charsPerMessage, 2 * i + 1),
            {}
          );
          const r1 = await historyService.appendToHistory(workspaceId, userMsg);
          expect(r1.success).toBe(true);
          const r2 = await historyService.appendToHistory(workspaceId, assistantMsg);
          expect(r2.success).toBe(true);
        }

        const integrationModel = COMPACTION_1M_RETRY_MODEL;

        // Send compaction request — use the same pattern as production /compact.
        // Crucially, do NOT enable 1M context in providerOptions; the retry should add it.
        const client = resolveOrpcClient(env);

        for (let attempt = 1; attempt <= MAX_PROVIDER_OVERLOAD_ATTEMPTS; attempt += 1) {
          const collector = createStreamCollector(env.orpc, workspaceId);
          collector.start();

          try {
            await collector.waitForSubscription(SUBSCRIPTION_SETUP_TIMEOUT_MS);
            const sendResult = await client.workspace.sendMessage({
              workspaceId,
              message:
                "Please provide a detailed summary of this conversation. " +
                "Capture all key decisions, context, and open questions.",
              options: {
                model: integrationModel,
                thinkingLevel: "off",
                agentId: "compact",
                // No providerOptions.anthropic.use1MContext here — the retry should inject it
                toolPolicy: [{ regex_match: ".*", action: "disable" }],
                muxMetadata: {
                  type: "compaction-request",
                  rawCommand: "/compact",
                  parsed: {},
                },
              },
            });

            expect(sendResult.success).toBe(true);

            // Wait for either stream-end (success) or stream-error (failure).
            // With 1M retry working, we expect stream-end.
            const terminalEvent = await Promise.race([
              collector.waitForEvent("stream-end", TEST_TIMEOUT_MS),
              collector.waitForEvent("stream-error", TEST_TIMEOUT_MS),
            ]);

            expect(terminalEvent).toBeDefined();

            if (terminalEvent?.type !== "stream-error") {
              expect(terminalEvent?.type).toBe("stream-end");
              return;
            }

            const errorType = "errorType" in terminalEvent ? terminalEvent.errorType : "unknown";
            const errorMsg = "error" in terminalEvent ? terminalEvent.error : "unknown";
            const isAnthropicOverload =
              errorType === "server_error" &&
              typeof errorMsg === "string" &&
              errorMsg.includes(ANTHROPIC_OVERLOAD_MESSAGE);
            if (isAnthropicOverload && attempt < MAX_PROVIDER_OVERLOAD_ATTEMPTS) {
              console.warn(
                `[tests] Retrying compaction 1M integration after transient Anthropic overload ` +
                  `(attempt ${attempt}/${MAX_PROVIDER_OVERLOAD_ATTEMPTS})`
              );
              await new Promise((resolve) =>
                setTimeout(resolve, PROVIDER_OVERLOAD_BACKOFF_MS * attempt)
              );
              continue;
            }

            if (isAnthropicOverload && process.env.CI) {
              console.warn(
                `[tests] Treating repeated Anthropic overload as inconclusive after ` +
                  `${MAX_PROVIDER_OVERLOAD_ATTEMPTS} CI attempts.`
              );
              return;
            }

            // A content-filter refusal is a provider classifier verdict on the padding, not a
            // compaction/context-window failure, and the error itself says retrying is unlikely
            // to help. The benign filler above makes this rare; in CI, report it instead of
            // failing unrelated PRs (issue #4398). Locally it still fails so it stays visible.
            if (errorType === "model_refusal" && process.env.CI) {
              console.warn(
                `[tests] Treating provider content-filter refusal as inconclusive in CI: ${errorMsg}`
              );
              return;
            }

            throw new Error(
              `Compaction failed (expected 1M retry to succeed): ` +
                `errorType=${errorType}, error=${errorMsg}`
            );
          } finally {
            await collector.waitForStop();
          }
        }
      } finally {
        await cleanup();
      }
    },
    TEST_TIMEOUT_BUDGET_MS
  );
});
