/**
 * Display usage utilities for renderer
 *
 * IMPORTANT: This file must NOT import tokenizer to avoid pulling Node.js
 * dependencies into the renderer bundle.
 */

import { getModelStats, type ModelStats } from "./modelStats";
import { readReportedServiceTier, withServiceTierPricing } from "./serviceTierPricing";
import { isPlainObject } from "@/common/utils/isPlainObject";
import { isTrustedStepStartList } from "@/common/utils/messages/stepStartPartIndices";
import {
  addLongContextTokens,
  clampLongContextTokens,
  getCacheCreate1hTokens,
  getLongContextTokens,
  NO_LONG_CONTEXT_TOKENS,
  scaleLongContextTokens,
  type ChatUsageDisplay,
  type LongContextTokens,
} from "./usageAggregator";
import {
  getPromptTokens,
  readLongContextTokens,
  readUsageTokens,
  toLongContextTokens,
  type AiSdkUsageLike,
  type UsageTokens,
} from "./usageHelpers";

/**
 * Version of the rules that price recorded usage, apart from the price tables. The analytics
 * DB hashes it into its pricing fingerprint, so a bump reprices every stored row on upgrade.
 * Bump it when a change prices already recorded usage differently.
 * 2: long-context tiers per request; legacy turns' tier and 1h writes from the last step.
 */
export const PRICING_LOGIC_VERSION = 2;

/**
 * Anthropic bills 1-hour-TTL cache writes at 2x base input (5-minute writes use the
 * model's `cache_creation_input_token_cost`, 1.25x). The catalog has no 1h field, so
 * the rate derives from the input rate of the same context tier and service tier.
 * https://platform.claude.com/docs/en/build-with-claude/prompt-caching#pricing
 */
const CACHE_WRITE_1H_INPUT_MULTIPLIER = 2;

interface RecomputeUsageCostsOptions {
  aggregatedUsage?: boolean;
}

interface UsageCosts {
  inputCost: number;
  cachedCost: number;
  cacheCreateCost: number;
  outputCost: number;
  reasoningCost: number;
}

interface TierRates {
  input: number;
  cached: number;
  cacheCreate: number;
  output: number;
}

function tierRates(modelStats: ModelStats, longContext: boolean): TierRates {
  // A token class without a long-context rate keeps its base rate in both tiers.
  const rate = (baseRate: number, longRate: number | undefined) =>
    longContext ? (longRate ?? baseRate) : baseRate;
  return {
    input: rate(modelStats.input_cost_per_token, modelStats.input_cost_per_token_above_200k_tokens),
    cached: rate(
      modelStats.cache_read_input_token_cost ?? 0,
      modelStats.cache_read_input_token_cost_above_200k_tokens
    ),
    cacheCreate: rate(
      modelStats.cache_creation_input_token_cost ?? 0,
      modelStats.cache_creation_input_token_cost_above_200k_tokens
    ),
    output: rate(
      modelStats.output_cost_per_token,
      modelStats.output_cost_per_token_above_200k_tokens
    ),
  };
}

function hasTieredPricing(modelStats: ModelStats): boolean {
  return (
    modelStats.input_cost_per_token_above_200k_tokens != null ||
    modelStats.output_cost_per_token_above_200k_tokens != null ||
    modelStats.cache_creation_input_token_cost_above_200k_tokens != null ||
    modelStats.cache_read_input_token_cost_above_200k_tokens != null
  );
}

/**
 * What a turn row records about its steps besides the summed usage. Rows from builds before
 * per-request long-context shares price their tier from it.
 */
export interface TurnSteps {
  /** The last step's usage (`metadata.contextUsage`). */
  lastStepUsage: AiSdkUsageLike;
  /** The last step's provider metadata (`metadata.contextProviderMetadata`). */
  lastStepProviderMetadata?: Record<string, unknown>;
  /**
   * The number of steps (`metadata.stepStartPartIndices`), a lower bound: a step that emitted
   * no part records no start. Absent or corrupted counts as one.
   */
  stepCount?: number;
}

function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** The turn's step record from persisted message metadata, which is not schema-validated. */
export function readTurnSteps(metadata: {
  compacted?: unknown;
  contextUsage?: unknown;
  contextProviderMetadata?: unknown;
  stepStartPartIndices?: unknown;
}): TurnSteps | undefined {
  // A compaction summary keeps its compaction request's usage, but its contextUsage is the
  // post-compaction context estimate (CompactionHandler), not a step of that request.
  if (metadata.compacted !== undefined && metadata.compacted !== false) return undefined;
  // A last step without a valid prompt count cannot place the turn's tier; the summed usage
  // then prices as one request.
  if (!isPlainObject(metadata.contextUsage) || !isTokenCount(metadata.contextUsage.inputTokens)) {
    return undefined;
  }
  return {
    lastStepUsage: metadata.contextUsage as AiSdkUsageLike,
    ...(isPlainObject(metadata.contextProviderMetadata) && {
      lastStepProviderMetadata: metadata.contextProviderMetadata,
    }),
    ...(isTrustedStepStartList(metadata.stepStartPartIndices) && {
      stepCount: metadata.stepStartPartIndices.length,
    }),
  };
}

/**
 * The last step's tokens; undefined when a count is malformed, or when its prompt exceeds the
 * turn's: the last step is one of the turn's requests, so that record is corrupted.
 */
function readLastStepTokens(steps: TurnSteps, tokens: UsageTokens): UsageTokens | undefined {
  const lastStep = readUsageTokens(steps.lastStepUsage, steps.lastStepProviderMetadata);
  if (!Object.values(lastStep).every(isTokenCount)) return undefined;
  return getPromptTokens(lastStep) > getPromptTokens(tokens) ? undefined : lastStep;
}

/**
 * Estimates the long-context share of a turn recorded without per-request shares from its
 * last step, the only step a legacy row keeps. Prompts usually grow within a turn, so a last
 * step at or under the threshold means no step crossed it, unless the earlier steps average
 * over it (a mid-turn compaction): then they price long and the last step base. Over it, the
 * last step prices long at its own counts, and the earlier steps past the threshold take
 * their share of the earlier steps' tokens (see {@link estimateEarlierShareOver}). On the
 * gateway's per-request ledger (Sept 15 to Oct 14) this came within 1.9% per model and the
 * compaction rule was exact, while pricing only the last step long was 13-67% low and the
 * whole turn 6-58% high. Undefined when the last step's counts are malformed or its prompt
 * exceeds the turn's.
 */
function estimateLongContextTokens(
  threshold: number,
  tokens: UsageTokens,
  steps: TurnSteps
): LongContextTokens | undefined {
  const lastStep = readLastStepTokens(steps, tokens);
  if (lastStep === undefined) return undefined;
  const lastPrompt = getPromptTokens(lastStep);
  const summedPrompt = getPromptTokens(tokens);
  const stepCount = Math.max(1, steps.stepCount ?? 1);
  const last = toLongContextTokens(lastStep);
  const earlier = addLongContextTokens(
    toLongContextTokens(tokens),
    scaleLongContextTokens(last, -1)
  );
  if (lastPrompt <= threshold) {
    const earlierSteps = stepCount - 1;
    const earlierStepsOver =
      earlierSteps > 0 && summedPrompt - lastPrompt > threshold * earlierSteps;
    return earlierStepsOver ? earlier : NO_LONG_CONTEXT_TOKENS;
  }
  const earlierShare = estimateEarlierShareOver(threshold, lastPrompt, summedPrompt, stepCount);
  return addLongContextTokens(last, scaleLongContextTokens(earlier, earlierShare));
}

/**
 * The share of the earlier steps' prompts in steps past the threshold, for a turn whose last
 * step is over it. Prompts are taken to grow evenly from the first step to the last. The
 * provider prices each request whole at one tier, so this counts whole steps and takes their
 * estimated prompts, not a fraction of the step that crosses the threshold.
 */
function estimateEarlierShareOver(
  threshold: number,
  lastPrompt: number,
  summedPrompt: number,
  recordedSteps: number
): number {
  const earlierPrompt = summedPrompt - lastPrompt;
  if (earlierPrompt <= 0) return 0;
  // No step's prompt is taken to exceed the last's, so the turn had at least
  // summedPrompt / lastPrompt steps, whatever the step list missed.
  const stepCount = Math.max(recordedSteps, Math.ceil(summedPrompt / lastPrompt));
  const firstPrompt = Math.min(
    lastPrompt,
    Math.max(0, (2 * summedPrompt) / stepCount - lastPrompt)
  );
  if (firstPrompt >= threshold) return 1;
  const growth = (lastPrompt - firstPrompt) / (stepCount - 1);
  const stepsOver = stepCount - 1 - Math.floor((threshold - firstPrompt) / growth);
  const earlierPromptsOver =
    (stepsOver - 1) * lastPrompt - (growth * stepsOver * (stepsOver - 1)) / 2;
  return Math.min(1, earlierPromptsOver / earlierPrompt);
}

/**
 * The share of `tokens` to price at long-context rates; undefined for models without tiered
 * pricing. Providers choose the tier per request from its prompt size and apply it to the
 * whole request (input, cache reads and writes, output). `recorded` is the per-request share
 * summed over the usage's requests. Without it a turn's tier is estimated from its `steps`,
 * and other usage prices as one request.
 */
function resolveLongContextTokens(
  modelStats: ModelStats,
  tokens: UsageTokens,
  recorded: LongContextTokens | undefined,
  steps: TurnSteps | undefined
): LongContextTokens | undefined {
  const threshold = modelStats.tiered_pricing_threshold_tokens;
  if (threshold === undefined) return undefined;
  const totals = toLongContextTokens(tokens);
  const share =
    recorded ??
    (steps === undefined ? undefined : estimateLongContextTokens(threshold, tokens, steps));
  if (share !== undefined) return clampLongContextTokens(share, totals);
  return getPromptTokens(tokens) > threshold ? totals : NO_LONG_CONTEXT_TOKENS;
}

/** Prices `longContext` (within `tokens`) at long-context rates and the rest at base rates. */
function calculateUsageCosts(
  modelStats: ModelStats,
  tokens: UsageTokens,
  longContext: LongContextTokens | undefined
): UsageCosts {
  const long = longContext ?? NO_LONG_CONTEXT_TOKENS;
  const baseRates = tierRates(modelStats, false);
  const longRates = tierRates(modelStats, true);
  const cost = (total: number, longShare: number, baseRate: number, longRate: number) =>
    (total - longShare) * baseRate + longShare * longRate;
  // The long share counts output and reasoning together; split it in their proportion.
  const totalOutput = tokens.output + tokens.reasoning;
  const longOutput = totalOutput > 0 ? (long.output * tokens.output) / totalOutput : 0;
  return {
    inputCost: cost(tokens.input, long.input, baseRates.input, longRates.input),
    cachedCost: cost(tokens.cached, long.cached, baseRates.cached, longRates.cached),
    cacheCreateCost:
      cost(
        tokens.cacheCreate - tokens.cacheCreate1h,
        long.cacheCreate - long.cacheCreate1h,
        baseRates.cacheCreate,
        longRates.cacheCreate
      ) +
      cost(
        tokens.cacheCreate1h,
        long.cacheCreate1h,
        baseRates.input * CACHE_WRITE_1H_INPUT_MULTIPLIER,
        longRates.input * CACHE_WRITE_1H_INPUT_MULTIPLIER
      ),
    outputCost: cost(tokens.output, longOutput, baseRates.output, longRates.output),
    reasoningCost: cost(
      tokens.reasoning,
      long.output - longOutput,
      baseRates.output,
      longRates.output
    ),
  };
}

/**
 * Create a display-friendly usage object from AI SDK usage
 *
 * This function transforms raw AI SDK usage data into a format suitable
 * for display in the UI. It does NOT require the tokenizer.
 *
 * Pass `turnSteps` when `usage` is a persisted turn's summed usage: it prices the context
 * tier of turns recorded without per-request long-context shares.
 */
export function createDisplayUsage(
  usage: AiSdkUsageLike | undefined,
  model: string,
  providerMetadata?: Record<string, unknown>,
  metadataModelOverride?: string,
  turnSteps?: TurnSteps
): ChatUsageDisplay | undefined {
  if (!usage) return undefined;

  const tokens = readUsageTokens(usage, providerMetadata);

  // Get model stats for cost calculation, at the service tier the provider
  // reported it billed (#4352); no reported tier keeps the base rates.
  const pricingModel = metadataModelOverride ?? model;
  const baseStats = getModelStats(pricingModel);
  const serviceTier = readReportedServiceTier(providerMetadata);
  const modelStats =
    baseStats !== null && serviceTier !== undefined
      ? withServiceTierPricing(baseStats, pricingModel, serviceTier)
      : baseStats;

  const costsIncluded =
    (providerMetadata?.mux as { costsIncluded?: boolean } | undefined)?.costsIncluded === true;

  // Calculate costs based on model stats (undefined if model unknown)
  let inputCost: number | undefined;
  let cachedCost: number | undefined;
  let cacheCreateCost: number | undefined;
  let outputCost: number | undefined;
  let reasoningCost: number | undefined;
  let longContextTokens: LongContextTokens | undefined;

  if (modelStats) {
    longContextTokens = resolveLongContextTokens(
      modelStats,
      tokens,
      readLongContextTokens(providerMetadata),
      turnSteps
    );
    const costs = calculateUsageCosts(modelStats, tokens, longContextTokens);
    inputCost = costs.inputCost;
    cachedCost = costs.cachedCost;
    cacheCreateCost = costs.cacheCreateCost;
    outputCost = costs.outputCost;
    reasoningCost = costs.reasoningCost;
  }

  const xaiCostInUsdTicks = (providerMetadata?.xai as { costInUsdTicks?: number } | undefined)
    ?.costInUsdTicks;
  const hasExactXaiCost =
    xaiCostInUsdTicks != null && Number.isFinite(xaiCostInUsdTicks) && xaiCostInUsdTicks >= 0;
  if (hasExactXaiCost) {
    // xAI reports the exact amount billed after caching, tools, and Priority Processing.
    // Scale the estimated component breakdown so its total reconciles to the billed amount.
    const exactCostUsd = xaiCostInUsdTicks / 10_000_000_000;
    const estimatedCosts = [inputCost, cachedCost, cacheCreateCost, outputCost, reasoningCost];
    const estimatedTotal = estimatedCosts.reduce<number>((sum, cost) => sum + (cost ?? 0), 0);

    if (estimatedTotal > 0) {
      const scale = exactCostUsd / estimatedTotal;
      inputCost = (inputCost ?? 0) * scale;
      cachedCost = (cachedCost ?? 0) * scale;
      cacheCreateCost = (cacheCreateCost ?? 0) * scale;
      outputCost = (outputCost ?? 0) * scale;
      reasoningCost = (reasoningCost ?? 0) * scale;
    } else {
      outputCost = exactCostUsd;
    }
  }

  if (costsIncluded) {
    inputCost = 0;
    cachedCost = 0;
    cacheCreateCost = 0;
    outputCost = 0;
    reasoningCost = 0;
  }

  return {
    ...(costsIncluded ? { costsIncluded: true } : {}),
    // Persisted so a later repricing uses the same tier (#4787).
    ...(serviceTier !== undefined && serviceTier !== "standard" ? { serviceTier } : {}),
    // Persisted so a later repricing keeps the 1h-TTL write premium.
    ...(tokens.cacheCreate1h > 0 ? { cacheCreate1hTokens: tokens.cacheCreate1h } : {}),
    // A billed amount cannot be repriced from tokens, so an exact xAI cost carries no share:
    // aggregates that include it keep their recorded costs.
    ...(longContextTokens !== undefined && !hasExactXaiCost ? { longContextTokens } : {}),
    input: {
      tokens: tokens.input,
      cost_usd: inputCost,
    },
    cached: {
      tokens: tokens.cached,
      cost_usd: cachedCost,
    },
    cacheCreate: {
      tokens: tokens.cacheCreate,
      cost_usd: cacheCreateCost,
    },
    output: {
      tokens: tokens.output,
      cost_usd: outputCost,
    },
    reasoning: {
      tokens: tokens.reasoning,
      cost_usd: reasoningCost,
    },
    model, // Include model for display purposes
  };
}

/**
 * Recompute cost_usd values in an existing ChatUsageDisplay using updated model pricing.
 *
 * Used when provider config changes (e.g., model mapping updated) to refresh
 * persisted session cost aggregates without discarding the raw token counts.
 *
 * Pass `{ aggregatedUsage: true }` for buckets like session `byModel` totals that may span
 * many requests. Tiered pricing is non-linear, so those aggregates, and usage carrying a
 * recorded long-context share, keep their recorded costs for models with tiered pricing.
 */
export function recomputeUsageCosts(
  usage: ChatUsageDisplay,
  metadataModel: string,
  options?: RecomputeUsageCostsOptions
): ChatUsageDisplay {
  const modelStats = getModelStats(metadataModel);
  const serviceTier = usage.serviceTier;
  // Self-healing: clamp malformed persisted 1h and long-context shares into the usage's
  // tokens and persist the clamped values, so a bad share cannot leak into later aggregates.
  const tokens: UsageTokens = {
    input: usage.input.tokens,
    cached: usage.cached.tokens,
    cacheCreate: usage.cacheCreate.tokens,
    cacheCreate1h: getCacheCreate1hTokens(usage),
    output: usage.output.tokens,
    reasoning: usage.reasoning.tokens,
  };
  const longContextTokens = getLongContextTokens(usage);
  const carriedFields = {
    ...(serviceTier !== undefined ? { serviceTier } : {}),
    ...(tokens.cacheCreate1h > 0 ? { cacheCreate1hTokens: tokens.cacheCreate1h } : {}),
    ...(longContextTokens !== undefined ? { longContextTokens } : {}),
  };

  if (!modelStats) {
    // Unknown model — strip costs and flag as unknown
    return {
      input: { tokens: usage.input.tokens },
      cached: { tokens: usage.cached.tokens },
      cacheCreate: { tokens: usage.cacheCreate.tokens },
      output: { tokens: usage.output.tokens },
      reasoning: { tokens: usage.reasoning.tokens },
      model: usage.model,
      hasUnknownCosts: true,
      ...carriedFields,
    };
  }

  // A sum cannot be split back into per-request tiers: neither service tiers (#4787) nor
  // context-window tiers, where pricing the summed prompt would bill every request at the
  // long-context rate. A recorded long-context share does not help: it says which requests
  // crossed the threshold of the model that recorded it, which this usage does not name, so
  // after a remap to a model with another threshold it would misclassify them. Each request
  // was priced at its own tiers when recorded, so keep those costs. They are known, not
  // "unknown": that warning is reserved for unpriced models, and flagging tiered sums showed
  // it for every session that used Haiku 5.5.
  if (
    serviceTier === "mixed" ||
    (hasTieredPricing(modelStats) &&
      (options?.aggregatedUsage === true || longContextTokens !== undefined))
  ) {
    // Keep the stored costs, but replace the 1h share with its clamped value, so a malformed
    // share cannot leak into later aggregates.
    const { cacheCreate1hTokens: _storedShare, ...storedUsage } = usage;
    return {
      ...storedUsage,
      ...carriedFields,
    };
  }

  const pricedStats =
    serviceTier !== undefined
      ? withServiceTierPricing(modelStats, metadataModel, serviceTier)
      : modelStats;
  const costs = calculateUsageCosts(
    pricedStats,
    tokens,
    resolveLongContextTokens(pricedStats, tokens, longContextTokens, undefined)
  );

  return {
    input: {
      tokens: usage.input.tokens,
      cost_usd: costs.inputCost,
    },
    cached: {
      tokens: usage.cached.tokens,
      cost_usd: costs.cachedCost,
    },
    cacheCreate: {
      tokens: usage.cacheCreate.tokens,
      cost_usd: costs.cacheCreateCost,
    },
    output: {
      tokens: usage.output.tokens,
      cost_usd: costs.outputCost,
    },
    reasoning: {
      tokens: usage.reasoning.tokens,
      cost_usd: costs.reasoningCost,
    },
    model: usage.model,
    ...carriedFields,
  };
}
