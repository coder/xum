/**
 * A compaction request whose own input is over the model's context window must still recover.
 *
 * Since #6268 the next turn replays long tool results in full (no 12,000-char cut), so an
 * over-window compaction request is more likely. Xum sends it as is: the request-time context
 * check skips compaction (turnRequestBuilder tokenBudgetEnabled), and nothing trims the input.
 * On context_exceeded, maybeRetryCompactionOnContextExceeded retries only GPT-class models
 * (OpenAI truncation) and Anthropic models that can switch to 1M context. Every other model
 * ends in a terminal error, and the renderer does not auto-compact a failed compaction
 * request (useCompactAndRetry), so the workspace is stuck until the user drops history by hand.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "events";

import type { SendMessageOptions } from "@/common/orpc/types";
import { Err } from "@/common/types/result";
import { expectReproFailure } from "@/node/utils/repro.testHarness";
import {
  createAgentSessionHarness,
  createFailedTurnHandle,
  createStartedTurnHandle,
} from "./agentSession.testHarness";
import { createTestHistoryService } from "./testHistoryService";

const FAILED_MESSAGE_ID = "assistant-compaction-ctx-exceeded";

describe("AgentSession: compaction request over the context window", () => {
  let historyCleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await historyCleanup?.();
  });

  /**
   * Run one compaction request whose first stream fails with context_exceeded, and return the
   * recovery decision plus how many streams Xum started.
   */
  async function runOverWindowCompaction(model: string) {
    const workspaceId = `ws-compaction-overflow-${model.replace(/\W/g, "-")}`;
    const { historyService, config, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;
    await historyService.appendToHistory(workspaceId, {
      id: "compaction-request-1",
      role: "user",
      parts: [{ type: "text", text: "Summarize the conversation." }],
      metadata: {
        timestamp: 1_000,
        muxMetadata: {
          type: "compaction-request",
          rawCommand: "/compact",
          parsed: {},
          source: "auto-compaction",
        },
      },
    } as Parameters<typeof historyService.appendToHistory>[1]);

    const aiEmitter = new EventEmitter();
    let calls = 0;
    const streamMessage = mock(() => {
      calls += 1;
      if (calls === 1) {
        aiEmitter.emit("error", {
          workspaceId,
          messageId: FAILED_MESSAGE_ID,
          error: "prompt is too long: 240000 tokens > 200000 maximum",
          errorType: "context_exceeded",
        });
        return Promise.resolve({
          success: true as const,
          data: createFailedTurnHandle(FAILED_MESSAGE_ID, {
            error: "prompt is too long",
            errorType: "context_exceeded",
          }),
        });
      }
      return Promise.resolve({
        success: true as const,
        data: createStartedTurnHandle(session.closingSignal, "assistant-compaction-retry"),
      });
    });

    const { session } = await createAgentSessionHarness({
      workspaceId,
      config,
      historyService,
      aiEmitter,
      aiServiceOverrides: {
        streamMessage,
        getWorkspaceMetadata: mock(() => Promise.resolve(Err("no metadata"))),
      },
    });
    try {
      await session.resumeStream({ model, agentId: "compact" } as SendMessageOptions);
      const decision = await session.waitForPendingStreamErrorRecoveryDecision(FAILED_MESSAGE_ID);
      return { decision, streams: calls };
    } finally {
      await session.dispose();
    }
  }

  test("control: a GPT-class compaction retries with OpenAI truncation", async () => {
    const { decision, streams } = await runOverWindowCompaction("openai:gpt-4o");
    expect(streams).toBe(2);
    expect(decision).toBe("retry-started");
  });

  // Repro (follow-up to #6268): no recovery for models without a GPT or 1M retry.
  test("a compaction request on a model without a 1M retry recovers", async () => {
    await expectReproFailure(
      async () => {
        const { decision } = await runOverWindowCompaction("anthropic:claude-haiku-4-5");
        expect(decision).toBe("retry-started");
      },
      { matcher: "toBe", expected: '"retry-started"', received: '"terminal"' }
    );
  });
});
