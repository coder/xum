/**
 * What a dream run has actually cost, and the cost ceiling it stops at.
 *
 * The ceiling never prices a step before it runs: a run's bill depends on the provider's cache,
 * service tier and premium modes, none of which a preflight guess can know. Each finished model
 * step is priced from the usage and provider metadata it reported, by the code that prices the
 * usage recorded for it (`createDisplayUsage`, which reads the billed service tier, Anthropic
 * speed and xAI's exact cost from that metadata). A run stops once its measured spend reaches
 * the ceiling, so the step in flight can go past it by up to one step's cost.
 */
import { MEMORY_MAX_OUTPUT_TOKENS_PER_STEP } from "@/common/constants/memory";
import { createDisplayUsage } from "@/common/utils/tokens/displayUsage";
import { getTotalCost } from "@/common/utils/tokens/usageAggregator";
import {
  accumulateStepsProviderMetadata,
  normalizeUsage,
  type AiSdkUsageLike,
} from "@/common/utils/tokens/usageHelpers";

interface PricedStep {
  usage?: AiSdkUsageLike;
  providerMetadata?: Record<string, unknown>;
}

/**
 * USD one model step cost, as the app prices usage it records; undefined for a model with no known
 * price. The cost displays show such a step as no cost, but a ceiling must tell it from a step
 * that cost nothing, because it can never stop a run it cannot price.
 */
export function stepCostUsd(
  step: PricedStep,
  pricingModel: string | undefined
): number | undefined {
  if (pricingModel === undefined) return undefined;
  // A one-step accumulation is what a recorded run passes with its steps: cache writes moved off
  // the usage, and the context tier of this request.
  const providerMetadata = accumulateStepsProviderMetadata([step], pricingModel);
  const cost = getTotalCost(
    createDisplayUsage(normalizeUsage(step.usage), pricingModel, providerMetadata, pricingModel)
  );
  return cost !== undefined && Number.isFinite(cost) ? cost : undefined;
}

export interface SpendMeter {
  /** Wire as `onStepEnd` of every stream of the run. */
  recordStep: (step: PricedStep) => void;
  /**
   * Wire into `stopWhen` of every stream of the run. A stream asks only when it has more steps to
   * take, so a true answer is a run the ceiling cut short, and the meter remembers that.
   */
  stopIfCeilingReached: () => boolean;
  /**
   * Wire as `maxOutputTokens` of every stream of the run. Bounds how far the step that crosses
   * the ceiling can overshoot it, so it exists only with a ceiling: a run with none keeps the
   * model's own limit.
   */
  maxOutputTokens: number | undefined;
  /** Measured USD, with what `spentUsd` of the meter's creation already held. */
  spentUsd: () => number;
  /**
   * What the run's record should say about its ceiling: that it cut the run short, or that it
   * could not (a step had no known price, so the spend stayed at zero). Undefined otherwise.
   */
  note: () => string | undefined;
}

/**
 * `spentUsd` carries the spend of earlier attempts at the same job: the ceiling is on the job, not
 * on one attempt. No `ceilingUsd` measures and never stops.
 */
export function createSpendMeter(args: {
  pricingModel: string | undefined;
  ceilingUsd?: number;
  spentUsd?: number;
}): SpendMeter {
  let spent = args.spentUsd ?? 0;
  let stopped = false;
  let unpriced = false;
  return {
    maxOutputTokens: args.ceilingUsd === undefined ? undefined : MEMORY_MAX_OUTPUT_TOKENS_PER_STEP,
    recordStep: (step) => {
      const cost = stepCostUsd(step, args.pricingModel);
      if (cost === undefined) unpriced = true;
      else spent += cost;
    },
    stopIfCeilingReached: () => {
      if (args.ceilingUsd === undefined || spent < args.ceilingUsd) return false;
      stopped = true;
      return true;
    },
    spentUsd: () => spent,
    note: () => {
      if (stopped) return `stopped at the cost ceiling after $${spent.toFixed(2)}`;
      if (unpriced && args.ceilingUsd !== undefined) return "price unknown, ceiling not enforced";
      return undefined;
    },
  };
}
