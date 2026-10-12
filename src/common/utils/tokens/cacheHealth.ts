/**
 * Prompt-cache health derived from the usage Xum already records.
 *
 * IMPORTANT: renderer-safe; must NOT import the tokenizer.
 */

import type { ChatUsageDisplay } from "./usageAggregator";

/**
 * A turn is a cold start when it wrote more than this share of its prompt to the
 * cache: the provider billed the prefix at write rates instead of reading it.
 */
export const COLD_START_CACHE_WRITE_SHARE = 0.5;

export interface CacheHealth {
  /** cache read / (cache read + cache write + uncached input); undefined without prompt tokens. */
  readRatio: number | undefined;
  cacheWriteTokens: number;
  /** Cache-write tokens at their billed 5m/1h rates; undefined when any pricing is unknown. */
  rewriteCostUsd: number | undefined;
  coldStart: boolean;
}

export interface TurnCacheHealth extends CacheHealth {
  messageId: string;
  timestamp?: number;
}

/**
 * Limit: Xum persists only turn totals (summed across a turn's tool-loop requests)
 * and the last request's usage, not the first request's. `coldStart` therefore
 * tests the turn total, so a cold first request followed by many warm requests can
 * fall under the threshold and go unflagged. Single-request turns are exact.
 */
export function getCacheHealth(usage: ChatUsageDisplay): CacheHealth {
  const promptTokens = usage.input.tokens + usage.cached.tokens + usage.cacheCreate.tokens;
  return {
    readRatio: promptTokens > 0 ? usage.cached.tokens / promptTokens : undefined,
    cacheWriteTokens: usage.cacheCreate.tokens,
    // sumUsageHistory counts an unpriced entry as $0 and only sets hasUnknownCosts, so
    // that flag must hide the cost too: "-" instead of a free-looking "$0.00".
    rewriteCostUsd: usage.hasUnknownCosts === true ? undefined : usage.cacheCreate.cost_usd,
    coldStart:
      promptTokens > 0 && usage.cacheCreate.tokens > promptTokens * COLD_START_CACHE_WRITE_SHARE,
  };
}
