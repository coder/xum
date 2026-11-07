/**
 * Upper-bound cost estimates for the dream's two model runs, and the ceiling check that refuses a
 * run before it starts.
 *
 * These are not bills. Each step of a run resends the prompt plus everything its earlier steps
 * read, and the run may take up to its step cap, so the estimate prices every step at the full
 * prompt plus every visible memory file. Real runs stop earlier and read less, and prompt
 * caching lowers the input price, so the bill usually falls well under the estimate.
 */
import {
  MEMORY_ANALYZER_MAX_STEPS,
  MEMORY_CONSOLIDATION_MAX_STEPS,
} from "@/common/constants/memory";
import { createDisplayUsage } from "@/common/utils/tokens/displayUsage";
import { getTotalCost } from "@/common/utils/tokens/usageAggregator";
import { APPROX_CHARS_PER_TOKEN } from "@/constants/streaming";

/**
 * Output of one step: a memory command carries the text it writes, and output costs several
 * times what input does, so ignoring it would let the estimate fall under the bill.
 */
const ESTIMATED_OUTPUT_TOKENS_PER_STEP = 1_000;

/**
 * Price of one step that sends `inputChars` characters, or undefined when the model has no known
 * price. One step is priced alone: a model's long-context tier is chosen per request, so pricing
 * the sum of the steps would charge the whole run at the long rate.
 */
function estimateStepUsd(pricingModel: string, inputChars: number): number | undefined {
  const usage = createDisplayUsage(
    {
      inputTokens: Math.ceil(inputChars / APPROX_CHARS_PER_TOKEN),
      outputTokens: ESTIMATED_OUTPUT_TOKENS_PER_STEP,
    },
    pricingModel
  );
  return getTotalCost(usage);
}

/**
 * Estimate of an analyzer job: each chunk (the characters its first step sends, system prompt
 * included) runs up to the analyzer's step cap, each step resending the chunk and `memoryChars`
 * of memory read.
 */
export function estimateAnalyzerUpperBoundUsd(args: {
  pricingModel: string;
  chunkInputChars: readonly number[];
  memoryChars: number;
}): number | undefined {
  let total = 0;
  for (const chunkChars of args.chunkInputChars) {
    const stepUsd = estimateStepUsd(args.pricingModel, chunkChars + args.memoryChars);
    if (stepUsd === undefined) return undefined;
    total += stepUsd * MEMORY_ANALYZER_MAX_STEPS;
  }
  return total;
}

/**
 * Estimate of an organizer run: up to the organizer's step cap, each step resending its system
 * prompt and `memoryChars` of memory read.
 */
export function estimateOrganizerUpperBoundUsd(args: {
  pricingModel: string;
  systemPromptChars: number;
  memoryChars: number;
}): number | undefined {
  const stepUsd = estimateStepUsd(args.pricingModel, args.systemPromptChars + args.memoryChars);
  return stepUsd === undefined ? undefined : stepUsd * MEMORY_CONSOLIDATION_MAX_STEPS;
}

export type CostCeilingCheck = { allowed: true } | { allowed: false; reason: string };

/** Rounded up, so an estimate over the ceiling never prints as equal to it. */
function formatUsd(usd: number): string {
  return (Math.ceil(usd * 100) / 100).toFixed(2);
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
  const ceiling = `${formatUsd(args.ceilingUsd)} USD ceiling`;
  if (args.estimatedUsd === undefined) {
    return {
      allowed: false,
      reason: `no price is known for ${args.pricingModel}, so its cost cannot be checked against the ${ceiling}`,
    };
  }
  if (args.estimatedUsd <= args.ceilingUsd) return { allowed: true };
  return {
    allowed: false,
    reason: `estimate ${formatUsd(args.estimatedUsd)} USD (an upper bound) is over the ${ceiling}`,
  };
}
