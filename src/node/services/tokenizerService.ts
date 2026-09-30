import { createHash } from "node:crypto";
import {
  countTokens,
  countTokensBatch,
  shouldUseApproxTokenizer,
} from "@/node/utils/main/tokenizer";
import { calculateTokenStats } from "@/common/utils/tokens/tokenStatsCalculator";
import type { MuxMessage } from "@/common/types/message";
import type { ChatStats } from "@/common/types/chatStats";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import assert from "@/common/utils/assert";
import { computeProvidersConfigFingerprint } from "@/common/utils/providers/configFingerprint";
import { getToolAvailabilityOptions } from "@/common/utils/tools/toolAvailability";
import { sliceMessagesForProviderFromLatestContextBoundary } from "@/common/utils/messages/compactionBoundary";
import { isPlanReviewRecordMessage } from "@/common/utils/planReview/planReviewEnvelope";
import type { SessionUsageService, SessionUsageTokenStatsCacheV1 } from "./sessionUsageService";
import { log } from "./log";
import type { AIService } from "./aiService";
import type { ProviderService } from "./providerService";
import { mergeTranscriptPartial, type HistoryService } from "./historyService";
import { VERSION } from "@/version";

/** The cache has no usageHistory, and the renderer drops it anyway. */
export type WorkspaceTokenStats = Omit<ChatStats, "usageHistory">;

function getMaxHistorySequence(messages: MuxMessage[]): number | undefined {
  let max: number | undefined;
  for (const message of messages) {
    const seq = message.metadata?.historySequence;
    if (typeof seq !== "number") {
      continue;
    }
    if (max === undefined || seq > max) {
      max = seq;
    }
  }
  return max;
}

export class TokenizerService {
  private readonly sessionUsageService: SessionUsageService;

  // Token stats calculations can overlap for a single workspace (e.g., rapid tool events).
  // The renderer ignores outdated results client-side, but the backend must also avoid
  // persisting stale `tokenStatsCache` data if an older calculation finishes after a newer one.
  private latestCalcIdByWorkspace = new Map<string, number>();
  private nextCalcId = 0;

  constructor(
    sessionUsageService: SessionUsageService,
    private readonly aiService: Pick<AIService, "getWorkspaceMetadata">,
    private readonly providerService: Pick<ProviderService, "getConfig">,
    private readonly historyService: Pick<
      HistoryService,
      "getHistoryFromLatestBoundary" | "readPartial" | "captureTokenStatsReceiptKey"
    >
  ) {
    this.sessionUsageService = sessionUsageService;
  }

  /**
   * Compute stats for the workspace's active context from the backend's own copy of history.
   *
   * The renderer used to upload its full message list with every recalculation (tool-call-end,
   * stream end, ...). During an active stream that was ~36 KB/s of redundant WebSocket traffic
   * per tab for a 370 KB history, so the IPC now carries only workspaceId + model and the
   * backend reads partial.json, then chat.jsonl, not under one lock; mergeTranscriptPartial's
   * part-count guard keeps a row committed in between from being replaced by the stale partial
   * (and the commit changes the history receipt, so that count is not cached). The partial read is
   * strict: a missing file is a normal "no in-flight turn" (null), and malformed JSON still
   * self-heals to null inside readPartial, but an I/O or permission failure rejects like a
   * history-read failure does, instead of silently persisting a cache that omits the turn.
   *
   * The calculation generation is claimed before any read so the latest-calculation guard
   * orders overlapping requests by arrival: a request that read an older transcript but
   * finished its reads later must not become "latest" and persist the older snapshot.
   * The cache is served without reading history only if the receipt and every input match;
   * a recount records its source only if the receipt is identical before and after the read.
   */
  async calculateWorkspaceStats(input: {
    workspaceId: string;
    model: string;
  }): Promise<WorkspaceTokenStats> {
    const calcId = this.beginCalculation(input.workspaceId);
    const [cached, metadata, partial, before] = await Promise.all([
      this.sessionUsageService.peekTokenStatsCache(input.workspaceId),
      this.aiService.getWorkspaceMetadata(input.workspaceId),
      this.historyService.readPartial(input.workspaceId, { throwOnError: true }),
      this.historyService.captureTokenStatsReceiptKey(input.workspaceId),
    ]);
    const providersConfig = this.providerService.getConfig();
    const parentWorkspaceId = metadata.success ? (metadata.data.parentWorkspaceId ?? null) : null;
    // Built from the exact objects that go into the count, never re-read after an await.
    // createHash, not crypto.hash: the headless CLI still accepts Node 20 before 20.12.
    const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
    const inputsKey = sha256(
      JSON.stringify({
        v: 1,
        partial: partial === null ? null : sha256(JSON.stringify(partial)),
        hasParent: Boolean(parentWorkspaceId),
        app: [VERSION.git_describe, VERSION.git_commit],
        approx: shouldUseApproxTokenizer(),
      })
    );
    if (
      cached?.source &&
      before !== null &&
      cached.model === input.model &&
      cached.providersConfigVersion === computeProvidersConfigFingerprint(providersConfig) &&
      cached.source.inputsKey === inputsKey &&
      cached.source.historyReceipt === before &&
      // Same invariants as the write path: corrupt counters are a miss (sum of tokens >= 0).
      cached.consumers.reduce((sum, c) => (c.tokens >= 0 ? sum + c.tokens : NaN), 0) ===
        cached.totalTokens
    ) {
      const { consumers, totalTokens, tokenizerName, topFilePaths } = cached;
      return { consumers, totalTokens, model: input.model, tokenizerName, topFilePaths };
    }
    const { workspaceId } = input;
    const historyResult = await this.historyService.getHistoryFromLatestBoundary(workspaceId, 0);
    if (!historyResult.success) {
      throw new Error(`Failed to read history for token stats: ${historyResult.error}`);
    }
    const after = await this.historyService.captureTokenStatsReceiptKey(workspaceId);
    const source =
      before !== null && after === before ? { historyReceipt: before, inputsKey } : undefined;
    const { usageHistory: _usageHistory, ...stats } = await this.calculateStatsForGeneration(
      calcId,
      input.workspaceId,
      mergeTranscriptPartial(historyResult.data, partial),
      input.model,
      providersConfig,
      parentWorkspaceId,
      source
    );
    return stats;
  }

  private beginCalculation(workspaceId: string): number {
    const calcId = ++this.nextCalcId;
    this.latestCalcIdByWorkspace.set(workspaceId, calcId);
    return calcId;
  }

  /**
   * Count tokens for a single string
   */
  async countTokens(model: string, text: string): Promise<number> {
    assert(
      typeof model === "string" && model.length > 0,
      "Tokenizer countTokens requires model name"
    );
    assert(typeof text === "string", "Tokenizer countTokens requires text");
    return countTokens(model, text);
  }

  /**
   * Count tokens for a batch of strings
   */
  async countTokensBatch(model: string, texts: string[]): Promise<number[]> {
    assert(
      typeof model === "string" && model.length > 0,
      "Tokenizer countTokensBatch requires model name"
    );
    assert(Array.isArray(texts), "Tokenizer countTokensBatch requires an array of strings");
    return countTokensBatch(model, texts);
  }

  /**
   * Calculate detailed token statistics for a chat history.
   */
  async calculateStats(
    workspaceId: string,
    messages: MuxMessage[],
    model: string,
    providersConfig: ProvidersConfigMap | null = null,
    parentWorkspaceId: string | null = null
  ): Promise<ChatStats> {
    assert(
      typeof workspaceId === "string" && workspaceId.length > 0,
      "Tokenizer calculateStats requires workspaceId"
    );
    return this.calculateStatsForGeneration(
      this.beginCalculation(workspaceId),
      workspaceId,
      messages,
      model,
      providersConfig,
      parentWorkspaceId
    );
  }

  private async calculateStatsForGeneration(
    calcId: number,
    workspaceId: string,
    messages: MuxMessage[],
    model: string,
    providersConfig: ProvidersConfigMap | null,
    parentWorkspaceId: string | null,
    source?: SessionUsageTokenStatsCacheV1["source"]
  ): Promise<ChatStats> {
    assert(Array.isArray(messages), "Tokenizer calculateStats requires an array of messages");
    assert(
      typeof model === "string" && model.length > 0,
      "Tokenizer calculateStats requires model name"
    );

    const activeContextMessages = sliceMessagesForProviderFromLatestContextBoundary(messages);
    // Plan-review records (snapshots can be tens of thousands of tokens) never reach a provider
    // request, so they must not count as context. The cache's history identity below still
    // describes the raw rows, which is what the client compares for freshness.
    const countedMessages = activeContextMessages.filter(
      (message) => !isPlanReviewRecordMessage(message)
    );

    const stats = await calculateTokenStats(
      countedMessages,
      model,
      providersConfig,
      getToolAvailabilityOptions({ workspaceId, parentWorkspaceId })
    );

    // Only persist the cache for the most recently-started calculation.
    // Older calculations can finish later and would otherwise overwrite a newer cache.
    if (this.latestCalcIdByWorkspace.get(workspaceId) !== calcId) {
      return stats;
    }

    const cache: SessionUsageTokenStatsCacheV1 = {
      version: 1,
      computedAt: Date.now(),
      providersConfigVersion: computeProvidersConfigFingerprint(providersConfig),
      model: stats.model,
      tokenizerName: stats.tokenizerName,
      history: {
        messageCount: activeContextMessages.length,
        maxHistorySequence: getMaxHistorySequence(activeContextMessages),
      },
      consumers: stats.consumers,
      totalTokens: stats.totalTokens,
      topFilePaths: stats.topFilePaths,
      ...(source && { source }),
    };

    // Defensive: keep cache invariants tight so we don't persist corrupt state.
    // Prefer returning stats over crashing the UI - if something is off, log and skip persisting.
    try {
      assert(cache.totalTokens >= 0, "Tokenizer calculateStats: cache.totalTokens must be >= 0");
      assert(
        cache.history.messageCount === activeContextMessages.length,
        "Tokenizer calculateStats: cache.history.messageCount must match active context length"
      );
      for (const consumer of cache.consumers) {
        assert(
          typeof consumer.tokens === "number" && consumer.tokens >= 0,
          `Tokenizer calculateStats: consumer.tokens must be >= 0 (${consumer.name})`
        );
      }

      const sumConsumerTokens = cache.consumers.reduce((sum, consumer) => sum + consumer.tokens, 0);
      assert(
        sumConsumerTokens === cache.totalTokens,
        `Tokenizer calculateStats: totalTokens mismatch (sum=${sumConsumerTokens}, total=${cache.totalTokens})`
      );
    } catch (error) {
      log.warn("[TokenizerService] Token stats cache invariant check failed; skipping persist", {
        workspaceId,
        error,
      });
      return stats;
    }

    try {
      await this.sessionUsageService.setTokenStatsCache(workspaceId, cache);
    } catch (error) {
      log.warn("[TokenizerService] Failed to persist token stats cache", { workspaceId, error });
    }

    return stats;
  }
}
