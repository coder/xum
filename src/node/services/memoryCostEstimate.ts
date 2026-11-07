/**
 * Upper-bound cost estimates for the dream's two model runs, and the ceiling check that refuses a
 * run before it starts.
 *
 * These are not bills. The estimate assumes the run takes every step its cap allows, that its
 * prompt already holds every visible memory file, and that each step writes a long reply. Real
 * runs stop earlier, read less and write less, so the bill usually falls well under the estimate.
 * The first step prices its prompt at the full input rate. Each later step resends that prefix,
 * and the provider serves it from its prompt cache, so the resent tokens price at the cache-read
 * rate when the model has one (the one run recorded on this host billed 93% of its input that
 * way). Pricing every step at the full rate made a minimal job look many times dearer than it was.
 * A model whose table lists a cache-write rate (Anthropic bills about 1.25x input) prices the first
 * step's prompt at it, since that step may be the one that writes the prefix to the cache, and an
 * estimate at the plain input rate would then fall under the bill.
 */
import {
  MEMORY_ANALYZER_MAX_STEPS,
  MEMORY_CONSOLIDATION_MAX_STEPS,
} from "@/common/constants/memory";
import { createDisplayUsage } from "@/common/utils/tokens/displayUsage";
import { getModelStats } from "@/common/utils/tokens/modelStats";
import { getTotalCost } from "@/common/utils/tokens/usageAggregator";
import { APPROX_CHARS_PER_TOKEN } from "@/constants/streaming";

/**
 * Output of one step: a memory command carries the text it writes, and output costs several
 * times what input does, so ignoring it would let the estimate fall under the bill. The next
 * step reads it back as input.
 */
const ESTIMATED_OUTPUT_TOKENS_PER_STEP = 1_000;

/**
 * Price of a run of `steps` steps over a prompt of `promptChars` characters, or undefined when
 * the model has no known price. Each step is priced as its own request: a model's long-context
 * tier is chosen per request, so pricing the sum of the steps would charge the whole run at the
 * long rate.
 */
function estimateRunUsd(
  pricingModel: string,
  promptChars: number,
  steps: number
): number | undefined {
  const promptTokens = Math.ceil(promptChars / APPROX_CHARS_PER_TOKEN);
  const stats = getModelStats(pricingModel);
  // A model with no cache-read price would price a cached token at zero, so its resent prefix
  // stays at the full input rate.
  const cachePriced = stats?.cache_read_input_token_cost !== undefined;
  const cacheWritePriced = stats?.cache_creation_input_token_cost !== undefined;
  let total = 0;
  for (let step = 1; step <= steps; step++) {
    const earlierOutputTokens = (step - 1) * ESTIMATED_OUTPUT_TOKENS_PER_STEP;
    // What the previous step sent: the prefix this step resends. Only the last output is new.
    const resentTokens =
      step === 1 ? 0 : promptTokens + earlierOutputTokens - ESTIMATED_OUTPUT_TOKENS_PER_STEP;
    const usd = getTotalCost(
      createDisplayUsage(
        {
          inputTokens: promptTokens + earlierOutputTokens,
          cachedInputTokens: cachePriced ? resentTokens : 0,
          ...(step === 1 && cacheWritePriced
            ? { inputTokenDetails: { cacheWriteTokens: promptTokens } }
            : {}),
          outputTokens: ESTIMATED_OUTPUT_TOKENS_PER_STEP,
        },
        pricingModel
      )
    );
    if (usd === undefined) return undefined;
    total += usd;
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
}): number | undefined {
  let total = 0;
  for (const chunkChars of args.chunkInputChars) {
    const chunkUsd = estimateRunUsd(
      args.pricingModel,
      chunkChars + args.memoryChars,
      MEMORY_ANALYZER_MAX_STEPS
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
}): number | undefined {
  return estimateRunUsd(
    args.pricingModel,
    args.systemPromptChars + args.memoryChars,
    MEMORY_CONSOLIDATION_MAX_STEPS
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
