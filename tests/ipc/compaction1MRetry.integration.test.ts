/**
 * Live integration test: native-1M compaction of a large request.
 *
 * Pre-seeds about 557k input tokens of conversation history (the varied filler tokenizes at
 * about 1.87 chars/token, not the 4 chars/token the size constant assumes), then runs /compact
 * on the pinned native-1M Sonnet model. It proves that a request well above 200k input tokens is
 * accepted and summarized into a compaction boundary. No 1M retry happens on this model; the
 * retry path is covered by compaction1MRetry.fixture.integration.test.ts (#4403).
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

// Sizing assumes 4 chars/token, so this seeds about 1.04M chars. The varied filler below
// tokenizes denser than that: live runs measured about 557k input tokens (#4856).
const TOKENS_PER_CHAR = 0.25;
const TARGET_TOKENS = 260_000;
// The request must be accepted above the old 200k default window to prove large-context support.
const MIN_ACCEPTED_INPUT_TOKENS = 200_000;
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
 * realistic for a /compact summary while still far exceeding a 200k context window.
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

const COMPACTION_1M_MODEL = "anthropic:claude-sonnet-4-6";
const ANTHROPIC_OVERLOAD_MESSAGE = "Anthropic is temporarily overloaded (HTTP 529)";
const MAX_PROVIDER_OVERLOAD_ATTEMPTS = process.env.CI ? 3 : 1;
const PROVIDER_OVERLOAD_BACKOFF_MS = 2_000;
const SUBSCRIPTION_SETUP_TIMEOUT_MS = 5_000;
const TOTAL_PROVIDER_OVERLOAD_BACKOFF_MS =
  (PROVIDER_OVERLOAD_BACKOFF_MS *
    ((MAX_PROVIDER_OVERLOAD_ATTEMPTS - 1) * MAX_PROVIDER_OVERLOAD_ATTEMPTS)) /
  2;
// Pinned to native-1M Sonnet: Haiku's context window is too small for this request.

describeIntegration("compaction of a native-1M request", () => {
  // Summarizing about 557k tokens of content can take a while.
  // When Anthropic is overloaded in CI, allow a few retries within the same test before
  // treating the result as inconclusive rather than failing the whole PR on provider flakiness.
  const TEST_TIMEOUT_MS = 180_000;
  const TEST_TIMEOUT_BUDGET_MS =
    TEST_TIMEOUT_MS * MAX_PROVIDER_OVERLOAD_ATTEMPTS +
    SUBSCRIPTION_SETUP_TIMEOUT_MS * MAX_PROVIDER_OVERLOAD_ATTEMPTS +
    TOTAL_PROVIDER_OVERLOAD_BACKOFF_MS +
    10_000;

  test(
    "compacts a request above 200k input tokens on a native-1M model",
    async () => {
      const { env, workspaceId, cleanup } = await setupWorkspace("anthropic");
      try {
        const historyService = new HistoryService(env.config);

        // Seed conversation history far above 200k tokens.
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

        const integrationModel = COMPACTION_1M_MODEL;

        // Send compaction request — use the same pattern as production /compact.
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
            const terminalEvent = await Promise.race([
              collector.waitForEvent("stream-end", TEST_TIMEOUT_MS),
              collector.waitForEvent("stream-error", TEST_TIMEOUT_MS),
            ]);

            expect(terminalEvent).toBeDefined();

            if (terminalEvent?.type !== "stream-error") {
              expect(terminalEvent?.type).toBe("stream-end");
              // A stream-end alone does not prove the large request was accepted.
              const inputTokens =
                terminalEvent?.type === "stream-end"
                  ? terminalEvent.metadata.usage?.inputTokens
                  : undefined;
              expect(inputTokens).toBeGreaterThan(MIN_ACCEPTED_INPUT_TOKENS);
              await env.services.workspaceService.getOrCreateSession(workspaceId).waitForIdle();
              const compacted = await historyService.getHistoryFromLatestBoundary(workspaceId);
              if (!compacted.success) throw new Error(compacted.error);
              expect(compacted.data[0]?.metadata?.compactionBoundary).toBe(true);
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

            // A content-filter refusal fails too, in CI as well: Jest runs with --silent, so a
            // warning-and-pass would hide a regression like #4398 (#4856).
            throw new Error(
              `Compaction of the large request failed: ` +
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
