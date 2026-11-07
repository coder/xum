/**
 * Upper-bound cost estimates for the dream's two model runs, and the ceiling check that refuses a
 * run before it starts.
 *
 * These are not bills, but they never fall under one: every assumption errs high. The run takes
 * every step its cap allows, its prompt already holds every visible memory file, and each step
 * writes as many tokens as the output cap lets it. That cap is on both streams, so it is a limit
 * of the run, not a guess; output costs several times what input does, and the next step reads
 * it back as input. The estimate also takes nothing it cannot guarantee. A provider's prompt
 * cache may miss, expire or be off for the route, so every input token of every step, the first
 * prompt and each resent prefix, prices at the uncached input rate. A model whose table lists a
 * cache-write rate (Anthropic bills about 1.25x input) prices the first step's prompt at the
 * higher of the two, since that step may be the one that writes the prefix to the cache. Real
 * runs stop earlier, read less, write less and hit the cache, so the bill usually falls well
 * under the estimate (the one run recorded on this host billed 93% of its input as cache reads).
 */
import {
  MEMORY_ANALYZER_MAX_STEPS,
  MEMORY_CONSOLIDATION_MAX_STEPS,
  MEMORY_MAX_OUTPUT_TOKENS_PER_STEP,
} from "@/common/constants/memory";
import type { ServiceTier } from "@/common/config/schemas/providersConfig";
import { createDisplayUsage } from "@/common/utils/tokens/displayUsage";
import { getModelStats } from "@/common/utils/tokens/modelStats";
import { getTotalCost } from "@/common/utils/tokens/usageAggregator";
import { APPROX_CHARS_PER_TOKEN } from "@/constants/streaming";

/**
 * Price of a run of `steps` steps over a prompt of `promptChars` characters, or undefined when
 * the model has no known price. Each step is priced as its own request: a model's long-context
 * tier is chosen per request, so pricing the sum of the steps would charge the whole run at the
 * long rate. `serviceTier` is the tier the run's requests carry (Fast, Flex, Ultrafast), priced
 * by the same code that prices a recorded run's reported tier.
 */
function estimateRunUsd(
  pricingModel: string,
  promptChars: number,
  steps: number,
  serviceTier: ServiceTier | undefined
): number | undefined {
  const promptTokens = Math.ceil(promptChars / APPROX_CHARS_PER_TOKEN);
  const cacheWritePriced =
    getModelStats(pricingModel)?.cache_creation_input_token_cost !== undefined;
  let total = 0;
  for (let step = 1; step <= steps; step++) {
    // Every token goes out again with each step, uncached: the prompt plus all earlier output.
    const inputTokens = promptTokens + (step - 1) * MEMORY_MAX_OUTPUT_TOKENS_PER_STEP;
    const stepUsd = (cacheWriteTokens: number) =>
      getTotalCost(
        createDisplayUsage(
          {
            inputTokens,
            outputTokens: MEMORY_MAX_OUTPUT_TOKENS_PER_STEP,
            inputTokenDetails: { cacheWriteTokens },
          },
          pricingModel,
          serviceTier === undefined ? undefined : { openai: { serviceTier } }
        )
      );
    const asInput = stepUsd(0);
    if (asInput === undefined) return undefined;
    // The first step may write its prompt to the cache. Pricing it both ways and keeping the
    // higher needs no assumption about which rate is higher.
    const asCacheWrite = step === 1 && cacheWritePriced ? stepUsd(promptTokens) : undefined;
    total += Math.max(asInput, asCacheWrite ?? 0);
  }
  return total;
}

/**
 * Estimate of an analyzer job: each chunk (the characters its first step sends, system prompt
 * included) runs up to the analyzer's step cap over the chunk and `memoryChars` of memory read.
 */
export function estimateAnalyzerUpperBoundUsd(args: {
  pricingModel: string;
  chunkInputChars: readonly number[];
  memoryChars: number;
  serviceTier?: ServiceTier;
}): number | undefined {
  let total = 0;
  for (const chunkChars of args.chunkInputChars) {
    const chunkUsd = estimateRunUsd(
      args.pricingModel,
      chunkChars + args.memoryChars,
      MEMORY_ANALYZER_MAX_STEPS,
      args.serviceTier
    );
    if (chunkUsd === undefined) return undefined;
    total += chunkUsd;
  }
  return total;
}

/**
 * Estimate of an organizer run: up to the organizer's step cap over its system prompt and
 * `memoryChars` of memory read.
 */
export function estimateOrganizerUpperBoundUsd(args: {
  pricingModel: string;
  systemPromptChars: number;
  memoryChars: number;
  serviceTier?: ServiceTier;
}): number | undefined {
  return estimateRunUsd(
    args.pricingModel,
    args.systemPromptChars + args.memoryChars,
    MEMORY_CONSOLIDATION_MAX_STEPS,
    args.serviceTier
  );
}

export type CostCeilingCheck = { allowed: true } | { allowed: false; reason: string };

/**
 * The ceiling as the user set it. Rounding it up like an estimate would print 1.1 as 1.11, because
 * 1.1 * 100 is 110.00000000000001.
 */
function formatCeilingUsd(usd: number): string {
  return usd.toFixed(2);
}

/**
 * Rounded up, so an estimate over the ceiling never prints as equal to it. The epsilon absorbs
 * binary noise (1.1 * 100 is 110.00000000000001), which would otherwise round an exact cent up.
 */
function formatEstimateUsd(usd: number): string {
  return (Math.ceil(usd * 100 - 1e-9) / 100).toFixed(2);
}

/**
 * Whether a run whose estimate is `estimatedUsd` may start under `ceilingUsd`. No ceiling allows
 * every run. With a ceiling set, a model with no known price is refused: its cost cannot be
 * checked, and a ceiling that silently let it through would not cap anything.
 */
export function checkCostCeiling(args: {
  ceilingUsd: number | undefined;
  estimatedUsd: number | undefined;
  pricingModel: string;
}): CostCeilingCheck {
  if (args.ceilingUsd === undefined) return { allowed: true };
  const ceiling = `${formatCeilingUsd(args.ceilingUsd)} USD ceiling`;
  if (args.estimatedUsd === undefined) {
    return {
      allowed: false,
      reason: `no price is known for ${args.pricingModel}, so its cost cannot be checked against the ${ceiling}`,
    };
  }
  if (args.estimatedUsd <= args.ceilingUsd) return { allowed: true };
  return {
    allowed: false,
    reason: `estimate ${formatEstimateUsd(args.estimatedUsd)} USD (an upper bound) is over the ${ceiling}`,
  };
}
