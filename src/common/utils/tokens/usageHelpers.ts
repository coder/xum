/**
 * Helper functions for accumulating usage and provider metadata across multi-step tool calls.
 *
 * For multi-step tool calls, the AI SDK reports usage per-step. We need to:
 * - Sum usage across all steps for cost calculation
 * - Track last step's usage for context window display (inputTokens = actual context size)
 * - Accumulate provider-specific metadata (e.g., Anthropic cache creation tokens)
 */

import type { LanguageModelV2Usage } from "@ai-sdk/provider";
import { isPlainObject } from "@/common/utils/isPlainObject";
import { getModelStats } from "./modelStats";
import { serviceTierCostRank } from "./serviceTierPricing";
import {
  addLongContextTokens,
  NO_LONG_CONTEXT_TOKENS,
  type LongContextTokens,
} from "./usageAggregator";

/**
 * Structural view of usage objects across AI SDK versions.
 *
 * AI SDK 7 moved `cachedInputTokens`/`reasoningTokens` into nested
 * `inputTokenDetails`/`outputTokenDetails`, and moved Anthropic cache-write
 * tokens from `providerMetadata.anthropic.cacheCreationInputTokens` into
 * `inputTokenDetails.cacheWriteTokens`. Xum persists (and sends over IPC) the
 * flat V2 shape, so live SDK usage must pass through {@link normalizeUsage}
 * before it is stored or displayed.
 */
export interface AiSdkUsageLike {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  // AI SDK <= 6 flat fields (also mux's persisted shape)
  reasoningTokens?: number;
  cachedInputTokens?: number;
  // AI SDK 7 nested details
  inputTokenDetails?: {
    noCacheTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  outputTokenDetails?: {
    textTokens?: number;
    reasoningTokens?: number;
  };
}

/**
 * Normalize an AI SDK usage object (v6 flat or v7 nested) into mux's persisted
 * flat V2 shape. Nested v7 details win when present; flat fields are kept as a
 * fallback so already-normalized/persisted usage passes through unchanged.
 */
export function normalizeUsage(usage: AiSdkUsageLike): LanguageModelV2Usage;
export function normalizeUsage(usage: AiSdkUsageLike | undefined): LanguageModelV2Usage | undefined;
export function normalizeUsage(
  usage: AiSdkUsageLike | undefined
): LanguageModelV2Usage | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    reasoningTokens: usage.outputTokenDetails?.reasoningTokens ?? usage.reasoningTokens,
    cachedInputTokens: usage.inputTokenDetails?.cacheReadTokens ?? usage.cachedInputTokens,
  };
}

/** Cache-write tokens reported by AI SDK 7 usage (0 for v6/normalized usage). */
export function getCacheWriteTokens(usage: AiSdkUsageLike | undefined): number {
  return usage?.inputTokenDetails?.cacheWriteTokens ?? 0;
}

/**
 * Merge AI SDK 7 cache-write tokens into provider metadata under
 * `anthropic.cacheCreationInputTokens`.
 *
 * AI SDK 7 removed that field from `providerMetadata.anthropic`; mux's persisted
 * metadata schema, pricing (createDisplayUsage), and historical rows all key off
 * it, so we synthesize it from usage at ingestion instead of migrating every
 * consumer. No-op when the usage reports no cache writes.
 */
export function withCacheWriteMetadata(
  metadata: Record<string, unknown> | undefined,
  usage: AiSdkUsageLike | undefined
): Record<string, unknown> | undefined {
  const cacheWriteTokens = getCacheWriteTokens(usage);
  if (cacheWriteTokens === 0) return metadata;
  return {
    ...(metadata ?? {}),
    anthropic: {
      ...(metadata?.anthropic as Record<string, unknown> | undefined),
      cacheCreationInputTokens: cacheWriteTokens,
    },
  };
}

function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Anthropic cache-write tokens written at the 1-hour TTL, out of
 * `cacheWriteTokens` (the request's or turn's `cacheCreationInputTokens`).
 *
 * Anthropic bills 1h writes at 2x base input, 5m writes at 1.25x, and reports the
 * split per response in the raw `usage.cache_creation`. That raw object comes from
 * the last step only, so {@link accumulateProviderMetadata} sums the 1h share of a
 * multi-step turn into `cacheCreation1hInputTokens`, which wins when present.
 * Rows from older builds carry only the last step's split. That split is used only
 * when it covers the whole `cacheWriteTokens`: earlier steps can have a different
 * 5m/1h mix (Anthropic server tools can write at 5m even with a 1h TTL configured),
 * so extrapolating the last step would misprice the turn. No usable split (other
 * providers, old multi-step rows) returns 0, which keeps the 5m price.
 */
export function getAnthropicCacheWrite1hTokens(
  providerMetadata: Record<string, unknown> | undefined,
  cacheWriteTokens: number
): number {
  if (cacheWriteTokens <= 0) return 0;
  const anthropic = providerMetadata?.anthropic as
    | {
        cacheCreation1hInputTokens?: unknown;
        usage?: {
          cache_creation?: {
            ephemeral_5m_input_tokens?: unknown;
            ephemeral_1h_input_tokens?: unknown;
          } | null;
        } | null;
      }
    | undefined;
  const summed = anthropic?.cacheCreation1hInputTokens;
  if (isTokenCount(summed)) return Math.min(summed, cacheWriteTokens);

  const split = anthropic?.usage?.cache_creation;
  const oneHour = split?.ephemeral_1h_input_tokens;
  if (!isTokenCount(oneHour) || oneHour === 0) return 0;
  const fiveMinute = split?.ephemeral_5m_input_tokens;
  // A present but malformed 5m share makes the split unreliable: keep the 5m price.
  if (fiveMinute != null && !isTokenCount(fiveMinute)) return 0;
  const reported = oneHour + (fiveMinute ?? 0);
  return reported === cacheWriteTokens ? oneHour : 0;
}

/** A request's or a turn's tokens, split into the classes providers bill. */
export interface UsageTokens {
  /** Input that was neither read from nor written to the prompt cache. */
  input: number;
  cached: number;
  cacheCreate: number;
  /** Share of cacheCreate written at the 1h TTL. */
  cacheCreate1h: number;
  /** Output excluding reasoning. */
  output: number;
  reasoning: number;
}

function readCacheWriteTokens(
  usage: AiSdkUsageLike,
  providerMetadata: Record<string, unknown> | undefined
): number {
  // Anthropic-specific; AI SDK 7 reports them on usage.inputTokenDetails instead.
  return (
    (providerMetadata?.anthropic as { cacheCreationInputTokens?: number } | undefined)
      ?.cacheCreationInputTokens ??
    usage.inputTokenDetails?.cacheWriteTokens ??
    0
  );
}

function readReasoningTokens(
  usage: AiSdkUsageLike,
  providerMetadata: Record<string, unknown> | undefined
): number {
  // Falls back to provider metadata (OpenAI-specific).
  return (
    usage.reasoningTokens ??
    usage.outputTokenDetails?.reasoningTokens ??
    (providerMetadata?.openai as { reasoningTokens?: number } | undefined)?.reasoningTokens ??
    0
  );
}

export function readUsageTokens(
  usage: AiSdkUsageLike,
  providerMetadata: Record<string, unknown> | undefined
): UsageTokens {
  // AI SDK v6 unified semantics: ALL providers now report inputTokens INCLUSIVE
  // of cached tokens. Previously Anthropic excluded cached tokens from inputTokens
  // but v6 changed this to match OpenAI/Google (inputTokens = total input including
  // cache_read + cache_write). We always subtract both cachedInputTokens and
  // cacheCreateTokens to get the true non-cached input count.
  // Self-healing: mux persists the flat v6 shape, but fall back to AI SDK 7's
  // nested token details in case an un-normalized usage object slips through.
  const cached = usage.cachedInputTokens ?? usage.inputTokenDetails?.cacheReadTokens ?? 0;
  const cacheCreate = readCacheWriteTokens(usage, providerMetadata);
  const reasoning = readReasoningTokens(usage, providerMetadata);
  // Inclusive semantics guarantees outputTokens >= reasoningTokens, so a smaller outputTokens
  // means the row was persisted with reasoning-exclusive output (historical Gemini-via-gateway
  // data); use it directly instead of clamping to 0.
  const rawOutput = usage.outputTokens ?? 0;
  return {
    // Math.max guards against pre-v6 historical data where inputTokens already excluded
    // cache tokens (subtraction would go negative).
    input: Math.max(0, (usage.inputTokens ?? 0) - cached - cacheCreate),
    cached,
    cacheCreate,
    cacheCreate1h: getAnthropicCacheWrite1hTokens(providerMetadata, cacheCreate),
    output: rawOutput >= reasoning ? rawOutput - reasoning : rawOutput,
    reasoning,
  };
}

/** A request's prompt size: providers choose its context tier from this count. */
export function getPromptTokens(tokens: UsageTokens): number {
  return tokens.input + tokens.cached + tokens.cacheCreate;
}

/** All of the tokens, in the shape of a long-context share. */
export function toLongContextTokens(tokens: UsageTokens): LongContextTokens {
  return {
    input: tokens.input,
    cached: tokens.cached,
    cacheCreate: tokens.cacheCreate,
    cacheCreate1h: tokens.cacheCreate1h,
    output: tokens.output + tokens.reasoning,
  };
}

function isLongContextTokens(value: unknown): value is LongContextTokens {
  return (
    isPlainObject(value) &&
    Object.keys(NO_LONG_CONTEXT_TOKENS).every((field) => isTokenCount(value[field]))
  );
}

/** The per-request long-context share recorded on provider metadata, if well formed. */
export function readLongContextTokens(
  providerMetadata: Record<string, unknown> | undefined
): LongContextTokens | undefined {
  const share = readMuxMetadata(providerMetadata)?.longContextTokens;
  return isLongContextTokens(share) ? share : undefined;
}

function readMuxMetadata(
  providerMetadata: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  const mux = providerMetadata?.mux;
  return isPlainObject(mux) ? mux : undefined;
}

/**
 * Records one request's long-context share in `mux.longContextTokens`, which
 * {@link accumulateProviderMetadata} sums across a turn's steps. Providers choose the tier
 * from each request's prompt, but a turn's usage sums every step, so its tier cannot be
 * chosen from the total. Only models with tiered pricing get the field. For them it is
 * written even under the threshold: its presence tells pricing every step was classified.
 */
export function withLongContextTokens(
  providerMetadata: Record<string, unknown> | undefined,
  usage: AiSdkUsageLike | undefined,
  pricingModel: string | undefined
): Record<string, unknown> | undefined {
  const threshold =
    pricingModel === undefined
      ? undefined
      : getModelStats(pricingModel)?.tiered_pricing_threshold_tokens;
  if (usage === undefined || threshold === undefined) return providerMetadata;
  const tokens = readUsageTokens(usage, providerMetadata);
  const longContextTokens =
    getPromptTokens(tokens) > threshold ? toLongContextTokens(tokens) : NO_LONG_CONTEXT_TOKENS;
  return {
    ...providerMetadata,
    mux: { ...readMuxMetadata(providerMetadata), longContextTokens: { ...longContextTokens } },
  };
}

/**
 * Add two LanguageModelV2Usage values together.
 * Handles undefined first argument and undefined fields within usage objects.
 */
export function addUsage(
  a: LanguageModelV2Usage | undefined,
  b: LanguageModelV2Usage
): LanguageModelV2Usage {
  return {
    inputTokens: (a?.inputTokens ?? 0) + (b.inputTokens ?? 0),
    outputTokens: (a?.outputTokens ?? 0) + (b.outputTokens ?? 0),
    totalTokens: (a?.totalTokens ?? 0) + (b.totalTokens ?? 0),
    cachedInputTokens: (a?.cachedInputTokens ?? 0) + (b.cachedInputTokens ?? 0),
    reasoningTokens: (a?.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0),
  };
}

/**
 * Accumulate provider metadata across steps for additive billing metadata.
 *
 * Anthropic cache creation tokens, xAI exact-cost ticks, and long-context shares are reported
 * per request/step and must be summed. Other provider metadata is taken from the latest step, except the
 * OpenAI service tier: stream totals are priced as one request, so the costliest tier any
 * step reported wins. This rewrites a provider field, but only with a value a step actually
 * reported; a turn downgraded midway is over-counted, never under-counted (#4352).
 */
export function accumulateProviderMetadata(
  existing: Record<string, unknown> | undefined,
  step: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!step) return existing;
  if (!existing) return step;

  const existingCacheCreate = readCacheCreationInputTokens(existing);
  const stepCacheCreate = readCacheCreationInputTokens(step);

  const totalCacheCreate = existingCacheCreate + stepCacheCreate;
  // The step's raw `anthropic.usage` replaces the earlier one, so carry the summed
  // 1h-TTL share explicitly (priced at 2x input instead of 1.25x).
  const totalCacheCreate1h =
    getAnthropicCacheWrite1hTokens(existing, existingCacheCreate) +
    getAnthropicCacheWrite1hTokens(step, stepCacheCreate);
  const totalXaiCostTicks = readXaiCostInUsdTicks(existing) + readXaiCostInUsdTicks(step);
  const existingServiceTier = readOpenAIServiceTier(existing);
  const keepExistingServiceTier =
    serviceTierCostRank(existingServiceTier) > serviceTierCostRank(readOpenAIServiceTier(step));
  const longContextTokens = sumRecordedLongContextTokens(existing, step);

  if (
    totalCacheCreate === 0 &&
    totalXaiCostTicks === 0 &&
    !keepExistingServiceTier &&
    longContextTokens === undefined
  ) {
    return step;
  }

  return {
    ...step,
    ...(totalCacheCreate > 0 && {
      anthropic: {
        ...(step.anthropic as Record<string, unknown> | undefined),
        cacheCreationInputTokens: totalCacheCreate,
        ...(totalCacheCreate1h > 0 && { cacheCreation1hInputTokens: totalCacheCreate1h }),
      },
    }),
    ...(totalXaiCostTicks > 0 && {
      xai: {
        ...(step.xai as Record<string, unknown> | undefined),
        costInUsdTicks: totalXaiCostTicks,
      },
    }),
    ...(keepExistingServiceTier && {
      openai: {
        ...(step.openai as Record<string, unknown> | undefined),
        serviceTier: existingServiceTier,
      },
    }),
    ...(longContextTokens !== undefined && {
      mux: { ...readMuxMetadata(step), longContextTokens },
    }),
  };
}

function readCacheCreationInputTokens(providerMetadata: Record<string, unknown>): number {
  return (
    (providerMetadata.anthropic as { cacheCreationInputTokens?: number } | undefined)
      ?.cacheCreationInputTokens ?? 0
  );
}

function readXaiCostInUsdTicks(providerMetadata: Record<string, unknown>): number {
  return (providerMetadata.xai as { costInUsdTicks?: number } | undefined)?.costInUsdTicks ?? 0;
}

function readOpenAIServiceTier(providerMetadata: Record<string, unknown>): unknown {
  return (providerMetadata.openai as { serviceTier?: unknown } | undefined)?.serviceTier;
}

/** The long-context shares of both sides summed; a side without one adds nothing. */
function sumRecordedLongContextTokens(
  existing: Record<string, unknown>,
  step: Record<string, unknown>
): LongContextTokens | undefined {
  const existingShare = readLongContextTokens(existing);
  const stepShare = readLongContextTokens(step);
  if (existingShare === undefined || stepShare === undefined) {
    return existingShare ?? stepShare;
  }
  return addLongContextTokens(existingShare, stepShare);
}

/**
 * Fold per-step provider metadata from an AI SDK stream result into a single
 * record via {@link accumulateProviderMetadata}.
 *
 * `streamResult.providerMetadata` alone only reflects the LAST step: on
 * multi-step tool loops it drops earlier steps' Anthropic cache-write tokens
 * (`cacheCreationInputTokens`), which then get priced as ordinary input.
 * Headless callers (status generation, memory sweeps) use this before
 * recordHeadlessUsage so cache writes price as cache-create spend and each step
 * keeps its own context tier (`pricingModel` supplies the threshold).
 */
export function accumulateStepsProviderMetadata(
  steps: ReadonlyArray<{ providerMetadata?: Record<string, unknown>; usage?: AiSdkUsageLike }>,
  pricingModel: string | undefined
): Record<string, unknown> | undefined {
  let accumulated: Record<string, unknown> | undefined;
  for (const step of steps) {
    // AI SDK 7 reports cache writes on step usage instead of provider metadata;
    // re-inject per step so the accumulation keeps summing across steps.
    const stepMetadata = withCacheWriteMetadata(step.providerMetadata, step.usage);
    accumulated = accumulateProviderMetadata(
      accumulated,
      withLongContextTokens(stepMetadata, step.usage, pricingModel)
    );
  }
  return accumulated;
}
