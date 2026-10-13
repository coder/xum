/**
 * A compaction request whose own input is over the model's context window must still recover.
 *
 * Since #6268 the next turn replays long tool results in full (no 12,000-char cut), so an
 * over-window compaction request is more likely. The request-time context check skips
 * compaction (turnRequestBuilder tokenBudgetEnabled); trimCompactionInput fits the input to an
 * estimated budget instead. When the estimate misses and the provider still answers
 * context_exceeded, maybeRetryCompactionOnContextExceeded retries once on every model, and the
 * retry trims to half the budget. Before this, models without OpenAI truncation or a 1M switch
 * ended terminal, and the renderer does not auto-compact a failed compaction request
 * (useCompactAndRetry), so the workspace stayed stuck.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "events";

import type { SendMessageOptions } from "@/common/orpc/types";
import { Err } from "@/common/types/result";
import { COMPACTION_RETRY_INPUT_BUDGET_SCALE } from "@/constants/continuousCompaction";
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
      const budgetScales = streamMessage.mock.calls.map(
        (call) => (call as unknown[])[0] as { compactionInputBudgetScale?: number }
      );
      return {
        decision,
        streams: calls,
        budgetScales: budgetScales.map((options) => options.compactionInputBudgetScale),
      };
    } finally {
      await session.dispose();
    }
  }

  test("control: a GPT-class compaction retries with OpenAI truncation", async () => {
    const { decision, streams } = await runOverWindowCompaction("openai:gpt-4o");
    expect(streams).toBe(2);
    expect(decision).toBe("retry-started");
  });

  test("a compaction request on a model without a 1M retry recovers", async () => {
    const { decision, streams, budgetScales } = await runOverWindowCompaction(
      "anthropic:claude-haiku-4-5"
    );
    expect(decision).toBe("retry-started");
    expect(streams).toBe(2);
    // The first attempt trims to the full budget, the one retry to half of it.
    expect(budgetScales).toEqual([undefined, COMPACTION_RETRY_INPUT_BUDGET_SCALE]);
  });
});
