/**
 * Display usage utilities for renderer
 *
 * IMPORTANT: This file must NOT import tokenizer to avoid pulling Node.js
 * dependencies into the renderer bundle.
 */

import { getModelStats, type ModelStats } from "./modelStats";
import { normalizeOpenAIServiceTier, withServiceTierPricing } from "./serviceTierPricing";
import type { ChatUsageDisplay } from "./usageAggregator";
import type { AiSdkUsageLike } from "./usageHelpers";

interface UsageCostInputs {
  inputTokens: number;
  cachedTokens: number;
  cacheCreateTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

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

function selectCostRate(
  modelStats: ModelStats,
  promptContextTokens: number,
  baseRate: number,
  highContextRate?: number
): number {
  if (
    highContextRate != null &&
    modelStats.tiered_pricing_threshold_tokens != null &&
    promptContextTokens > modelStats.tiered_pricing_threshold_tokens
  ) {
    return highContextRate;
  }

  return baseRate;
}

function hasTieredPricing(modelStats: ModelStats): boolean {
  return (
    modelStats.input_cost_per_token_above_200k_tokens != null ||
    modelStats.output_cost_per_token_above_200k_tokens != null ||
    modelStats.cache_creation_input_token_cost_above_200k_tokens != null ||
    modelStats.cache_read_input_token_cost_above_200k_tokens != null
  );
}

function calculateUsageCosts(modelStats: ModelStats, usage: UsageCostInputs): UsageCosts {
  // Long-context providers price the entire prompt tier (input/cache reads/cache writes)
  // based on prompt size, then reuse that same tier for output/reasoning charges.
  const promptContextTokens = usage.inputTokens + usage.cachedTokens + usage.cacheCreateTokens;
  const inputRate = selectCostRate(
    modelStats,
    promptContextTokens,
    modelStats.input_cost_per_token,
    modelStats.input_cost_per_token_above_200k_tokens
  );
  const cachedRate = selectCostRate(
    modelStats,
    promptContextTokens,
    modelStats.cache_read_input_token_cost ?? 0,
    modelStats.cache_read_input_token_cost_above_200k_tokens
  );
  const cacheCreateRate = selectCostRate(
    modelStats,
    promptContextTokens,
    modelStats.cache_creation_input_token_cost ?? 0,
    modelStats.cache_creation_input_token_cost_above_200k_tokens
  );
  const outputRate = selectCostRate(
    modelStats,
    promptContextTokens,
    modelStats.output_cost_per_token,
    modelStats.output_cost_per_token_above_200k_tokens
  );

  return {
    inputCost: usage.inputTokens * inputRate,
    cachedCost: usage.cachedTokens * cachedRate,
    cacheCreateCost: usage.cacheCreateTokens * cacheCreateRate,
    outputCost: usage.outputTokens * outputRate,
    reasoningCost: usage.reasoningTokens * outputRate,
  };
}

/**
 * Create a display-friendly usage object from AI SDK usage
 *
 * This function transforms raw AI SDK usage data into a format suitable
 * for display in the UI. It does NOT require the tokenizer.
 */
export function createDisplayUsage(
  usage: AiSdkUsageLike | undefined,
  model: string,
  providerMetadata?: Record<string, unknown>,
  metadataModelOverride?: string
): ChatUsageDisplay | undefined {
  if (!usage) return undefined;

  // AI SDK v6 unified semantics: ALL providers now report inputTokens INCLUSIVE
  // of cached tokens. Previously Anthropic excluded cached tokens from inputTokens
  // but v6 changed this to match OpenAI/Google (inputTokens = total input including
  // cache_read + cache_write). We always subtract both cachedInputTokens and
  // cacheCreateTokens to get the true non-cached input count.
  // Self-healing: mux persists the flat v6 shape, but fall back to AI SDK 7's
  // nested token details in case an un-normalized usage object slips through.
  const cachedTokens = usage.cachedInputTokens ?? usage.inputTokenDetails?.cacheReadTokens ?? 0;
  const rawInputTokens = usage.inputTokens ?? 0;

  // Extract cache creation tokens from provider metadata (Anthropic-specific;
  // AI SDK 7 reports them on usage.inputTokenDetails instead).
  // Needed before computing inputTokens since we subtract it from the total.
  const cacheCreateTokens =
    (providerMetadata?.anthropic as { cacheCreationInputTokens?: number } | undefined)
      ?.cacheCreationInputTokens ??
    usage.inputTokenDetails?.cacheWriteTokens ??
    0;

  // Subtract both cache-read and cache-create tokens to isolate non-cached input.
  // Math.max guards against pre-v6 historical data where inputTokens already excluded
  // cache tokens (subtraction would go negative).
  const inputTokens = Math.max(0, rawInputTokens - cachedTokens - cacheCreateTokens);

  // Extract reasoning tokens with fallback to provider metadata (OpenAI-specific)
  const reasoningTokens =
    usage.reasoningTokens ??
    usage.outputTokenDetails?.reasoningTokens ??
    (providerMetadata?.openai as { reasoningTokens?: number } | undefined)?.reasoningTokens ??
    0;

  // Calculate output tokens excluding reasoning. Inclusive semantics guarantees
  // outputTokens >= reasoningTokens, so a smaller outputTokens means the row was
  // persisted with reasoning-exclusive output (historical Gemini-via-gateway data);
  // use it directly instead of clamping to 0.
  const rawOutputTokens = usage.outputTokens ?? 0;
  const outputWithoutReasoning =
    rawOutputTokens >= reasoningTokens ? rawOutputTokens - reasoningTokens : rawOutputTokens;

  // Get model stats for cost calculation, at the service tier the provider
  // reported it billed (#4352); no reported tier keeps the base rates.
  const pricingModel = metadataModelOverride ?? model;
  const baseStats = getModelStats(pricingModel);
  const serviceTier = normalizeOpenAIServiceTier(
    (providerMetadata?.openai as { serviceTier?: unknown } | undefined)?.serviceTier
  );
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

  if (modelStats) {
    const costs = calculateUsageCosts(modelStats, {
      inputTokens,
      cachedTokens,
      cacheCreateTokens,
      outputTokens: outputWithoutReasoning,
      reasoningTokens,
    });
    inputCost = costs.inputCost;
    cachedCost = costs.cachedCost;
    cacheCreateCost = costs.cacheCreateCost;
    outputCost = costs.outputCost;
    reasoningCost = costs.reasoningCost;
  }

  const xaiCostInUsdTicks = (providerMetadata?.xai as { costInUsdTicks?: number } | undefined)
    ?.costInUsdTicks;
  if (xaiCostInUsdTicks != null && Number.isFinite(xaiCostInUsdTicks) && xaiCostInUsdTicks >= 0) {
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
    input: {
      tokens: inputTokens,
      cost_usd: inputCost,
    },
    cached: {
      tokens: cachedTokens,
      cost_usd: cachedCost,
    },
    cacheCreate: {
      tokens: cacheCreateTokens,
      cost_usd: cacheCreateCost,
    },
    output: {
      tokens: outputWithoutReasoning,
      cost_usd: outputCost,
    },
    reasoning: {
      tokens: reasoningTokens,
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
 * many requests. Tiered pricing is non-linear, so those aggregates cannot be safely repriced
 * from summed tokens alone.
 */
export function recomputeUsageCosts(
  usage: ChatUsageDisplay,
  metadataModel: string,
  options?: RecomputeUsageCostsOptions
): ChatUsageDisplay {
  const modelStats = getModelStats(metadataModel);
  const serviceTier = usage.serviceTier;
  const tierField = serviceTier !== undefined ? { serviceTier } : {};

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
      ...tierField,
    };
  }

  // A sum across service tiers cannot be split back into per-tier tokens (#4787).
  if (
    serviceTier === "mixed" ||
    (options?.aggregatedUsage === true && hasTieredPricing(modelStats))
  ) {
    // Aggregated `byModel` totals collapse many requests into one bucket. Tiered pricing is
    // non-linear, so choosing a single tier from the sum can inflate costs once multiple
    // sub-threshold requests add up past the long-context boundary. Preserve the stored costs
    // and surface uncertainty instead of fabricating a repriced total.
    return {
      ...usage,
      hasUnknownCosts: true,
    };
  }

  const pricedStats =
    serviceTier !== undefined
      ? withServiceTierPricing(modelStats, metadataModel, serviceTier)
      : modelStats;
  const costs = calculateUsageCosts(pricedStats, {
    inputTokens: usage.input.tokens,
    cachedTokens: usage.cached.tokens,
    cacheCreateTokens: usage.cacheCreate.tokens,
    outputTokens: usage.output.tokens,
    reasoningTokens: usage.reasoning.tokens,
  });

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
    ...tierField,
  };
}
