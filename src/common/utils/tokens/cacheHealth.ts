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
  /** Cache-write tokens at their billed 5m/1h rates; undefined when a cache write is unpriced. */
  rewriteCostUsd: number | undefined;
  coldStart: boolean;
}

export interface TurnCacheHealth extends CacheHealth {
  messageId: string;
  timestamp?: number;
}

/** One request's usage (or a per-model session bucket) that cache health sums. */
export interface CacheHealthPart {
  usage: ChatUsageDisplay;
  /** The raw `inputTokens` the usage was built from, when known (one persisted request). */
  rawInputTokens?: number;
}

/**
 * Uncached prompt tokens of one part. Since AI SDK v6, `inputTokens` includes cache reads
 * and writes, and createDisplayUsage subtracts them. Anthropic rows recorded before v6
 * reported `inputTokens` without cache tokens, so that subtraction clamps their uncached
 * input to 0. A raw count below the cache tokens can only be such a row, and its raw
 * count is the uncached input. A pre-v6 row whose uncached input exceeds its cache
 * tokens cannot be told apart and is read as v6.
 */
function getUncachedInputTokens(part: CacheHealthPart): number {
  const cacheTokens = part.usage.cached.tokens + part.usage.cacheCreate.tokens;
  // Self-healing: only a real token count can be a legacy row's uncached input. A malformed
  // raw count (negative, NaN, infinite) keeps the display usage's clamped value.
  const raw = part.rawInputTokens;
  return raw !== undefined && Number.isFinite(raw) && raw >= 0 && raw < cacheTokens
    ? raw
    : part.usage.input.tokens;
}

/**
 * Adds one part's cache-write cost. Unknownness covers the cache-write component only: an
 * unpriced part that wrote nothing must not hide a known rewrite cost. A summed bucket
 * (sumUsageHistory) counts an unpriced entry as $0 and only sets hasUnknownCosts, so that
 * flag counts as unpriced.
 */
function addRewriteCostUsd(total: number | undefined, part: CacheHealthPart): number | undefined {
  if (part.usage.cacheCreate.tokens === 0) return total;
  const cost = part.usage.hasUnknownCosts === true ? undefined : part.usage.cacheCreate.cost_usd;
  return total === undefined || cost === undefined ? undefined : total + cost;
}

/**
 * Limit: Xum persists only turn totals (summed across a turn's tool-loop requests)
 * and the last request's usage, not the first request's. `coldStart` therefore
 * tests the turn total, so a cold first request followed by many warm requests can
 * fall under the threshold and go unflagged. Single-request turns are exact.
 */
export function getCacheHealth(parts: readonly CacheHealthPart[]): CacheHealth {
  let uncachedTokens = 0;
  let readTokens = 0;
  let writeTokens = 0;
  let rewriteCostUsd: number | undefined = 0;
  for (const part of parts) {
    uncachedTokens += getUncachedInputTokens(part);
    readTokens += part.usage.cached.tokens;
    writeTokens += part.usage.cacheCreate.tokens;
    rewriteCostUsd = addRewriteCostUsd(rewriteCostUsd, part);
  }
  const promptTokens = uncachedTokens + readTokens + writeTokens;
  return {
    readRatio: promptTokens > 0 ? readTokens / promptTokens : undefined,
    cacheWriteTokens: writeTokens,
    rewriteCostUsd,
    coldStart: promptTokens > 0 && writeTokens > promptTokens * COLD_START_CACHE_WRITE_SHARE,
  };
}

/** Session cache health: the per-model ledger buckets plus the live stream's usage. */
export function getSessionCacheHealth(
  byModel: Readonly<Record<string, ChatUsageDisplay>> | undefined,
  live: ChatUsageDisplay | undefined
): CacheHealth {
  const buckets = Object.values(byModel ?? {});
  return getCacheHealth([...buckets, ...(live ? [live] : [])].map((usage) => ({ usage })));
}
