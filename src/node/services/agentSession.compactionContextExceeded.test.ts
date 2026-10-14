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
const FAILED_RETRY_MESSAGE_ID = "assistant-compaction-retry-ctx-exceeded";

describe("AgentSession: compaction request over the context window", () => {
  let historyCleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await historyCleanup?.();
  });

  /**
   * Run one compaction request whose first stream fails with context_exceeded, and return the
   * recovery decision plus how many streams Xum started. With `resumeAfterFailedRetry`, the
   * retry overflows too, and the user then resumes the same compaction request.
   */
  async function runOverWindowCompaction(
    model: string,
    options: {
      resumeAfterFailedRetry?: boolean;
      withoutRequestMetadata?: boolean;
      /** The refusal fallback the first stream swapped to before it overflowed. */
      overflowedOn?: string;
    } = {}
  ) {
    const workspaceId = `ws-compaction-overflow-${model.replace(/\W/g, "-")}`;
    const { historyService, config, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;
    await historyService.appendToHistory(workspaceId, {
      id: "compaction-request-1",
      role: "user",
      parts: [{ type: "text", text: "Summarize the conversation." }],
      metadata: {
        timestamp: 1_000,
        ...(options.withoutRequestMetadata
          ? {}
          : {
              muxMetadata: {
                type: "compaction-request",
                rawCommand: "/compact",
                parsed: {},
                source: "auto-compaction",
              },
            }),
      },
    } as Parameters<typeof historyService.appendToHistory>[1]);

    const aiEmitter = new EventEmitter();
    let calls = 0;
    const overflow = (messageId: string) => {
      aiEmitter.emit("error", {
        workspaceId,
        messageId,
        error: "prompt is too long: 240000 tokens > 200000 maximum",
        errorType: "context_exceeded",
      });
      return Promise.resolve({
        success: true as const,
        data: createFailedTurnHandle(messageId, {
          error: "prompt is too long",
          errorType: "context_exceeded",
          // The engine names the model the stream ran on (StreamErrorPayload.model).
          model: options.overflowedOn ?? model,
        }),
      });
    };
    const streamMessage = mock(() => {
      calls += 1;
      if (calls === 1) return overflow(FAILED_MESSAGE_ID);
      if (calls === 2 && options.resumeAfterFailedRetry) return overflow(FAILED_RETRY_MESSAGE_ID);
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
      if (options.resumeAfterFailedRetry) {
        await session.waitForPendingStreamErrorRecoveryDecision(FAILED_RETRY_MESSAGE_ID);
        await session.resumeStream({ model, agentId: "compact" } as SendMessageOptions);
      }
      const requests = streamMessage.mock.calls.map(
        (call) =>
          (call as unknown[])[0] as {
            compactionInputBudgetScale?: number;
            compactionContextRetryAvailable?: boolean;
            muxProviderOptions?: unknown;
            modelString?: string;
            openaiTruncationModeOverride?: string;
          }
      );
      return {
        decision,
        streams: calls,
        budgetScales: requests.map((options) => options.compactionInputBudgetScale),
        retryAvailable: requests.map((options) => options.compactionContextRetryAvailable),
        retryProviderOptions: requests[1]?.muxProviderOptions,
        retryModel: requests[1]?.modelString,
        retryTruncation: requests[1]?.openaiTruncationModeOverride,
      };
    } finally {
      await session.dispose();
    }
  }

  test("control: a GPT-class compaction retries with OpenAI truncation", async () => {
    const { decision, streams, budgetScales } = await runOverWindowCompaction("openai:gpt-4o");
    expect(streams).toBe(2);
    expect(decision).toBe("retry-started");
    // GPT-class keeps the first-attempt trim, and its retry trims to half the budget.
    expect(budgetScales).toEqual([undefined, COMPACTION_RETRY_INPUT_BUDGET_SCALE]);
  });

  test("a model that can switch to 1M retries at 1M without the half budget", async () => {
    const { decision, streams, budgetScales, retryProviderOptions, retryAvailable } =
      await runOverWindowCompaction("anthropic:claude-sonnet-4-5");
    expect(decision).toBe("retry-started");
    expect(streams).toBe(2);
    // The retry trims to 70% of the 1M window (turnRequestBuilder), not to half of 200k.
    expect(budgetScales).toEqual([undefined, undefined]);
    expect(retryProviderOptions).toMatchObject({ anthropic: { use1MContext: true } });
    // The first attempt skips its trim only because this retry follows it.
    expect(retryAvailable).toEqual([true, false]);
  });

  test("a compact-agent resume without compaction metadata is told it has no retry", async () => {
    // No compaction-request row, so no retry is registered: TurnRequestBuilder must trim the
    // first attempt, or a model that could switch to 1M overflows with nothing to recover it.
    const { decision, streams, retryAvailable } = await runOverWindowCompaction(
      "anthropic:claude-sonnet-4-5",
      { withoutRequestMetadata: true }
    );
    expect(decision).toBe("terminal");
    expect(streams).toBe(1);
    expect(retryAvailable).toEqual([false]);
  });

  // A refusal fallback overflowed: its own window decides the plan. The retry starts on the
  // requested model again, and the builder's fallback rebuild uses the same options and scale.
  test("a GPT-class fallback that overflowed gets the GPT-class retry", async () => {
    const { budgetScales, retryModel, retryTruncation } = await runOverWindowCompaction(
      "anthropic:claude-sonnet-4-5",
      { overflowedOn: "openai:gpt-4o" }
    );
    expect(retryModel).toBe("anthropic:claude-sonnet-4-5");
    expect(retryTruncation).toBe("auto");
    expect(budgetScales).toEqual([undefined, COMPACTION_RETRY_INPUT_BUDGET_SCALE]);
  });

  test("a fallback that can switch to 1M retries with 1M on for that fallback", async () => {
    const fallback = "anthropic:claude-sonnet-4-5";
    const { budgetScales, retryModel, retryProviderOptions } = await runOverWindowCompaction(
      "openai:gpt-4o",
      { overflowedOn: fallback }
    );
    expect(retryModel).toBe("openai:gpt-4o");
    expect(retryProviderOptions).toMatchObject({ anthropic: { use1MContextModels: [fallback] } });
    expect(budgetScales).toEqual([undefined, undefined]);
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

  test("a resume after the automatic retry ended trims to the full budget again", async () => {
    // The resume reuses the compaction request ID. The half budget belongs to the automatic
    // retry only: the user can resume on a larger model or after the history changed.
    const { streams, budgetScales } = await runOverWindowCompaction("anthropic:claude-haiku-4-5", {
      resumeAfterFailedRetry: true,
    });
    expect(streams).toBe(3);
    expect(budgetScales).toEqual([undefined, COMPACTION_RETRY_INPUT_BUDGET_SCALE, undefined]);
  });
});
