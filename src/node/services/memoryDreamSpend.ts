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
 * USD one model step cost, as the app prices usage it records. A model with no known price costs
 * nothing here, as it does in every cost display.
 */
export function stepCostUsd(step: PricedStep, pricingModel: string | undefined): number {
  if (pricingModel === undefined) return 0;
  // A one-step accumulation is what a recorded run passes with its steps: cache writes moved off
  // the usage, and the context tier of this request.
  const providerMetadata = accumulateStepsProviderMetadata([step], pricingModel);
  const cost = getTotalCost(
    createDisplayUsage(normalizeUsage(step.usage), pricingModel, providerMetadata, pricingModel)
  );
  return cost !== undefined && Number.isFinite(cost) ? cost : 0;
}

export interface SpendMeter {
  /** Wire as `onStepEnd` of every stream of the run. */
  recordStep: (step: PricedStep) => void;
  /**
   * Wire into `stopWhen` of every stream of the run. A stream asks only when it has more steps to
   * take, so a true answer is a run the ceiling cut short, and the meter remembers that.
   */
  stopIfCeilingReached: () => boolean;
  /** Measured USD, with what `spentUsd` of the meter's creation already held. */
  spentUsd: () => number;
  /** The note of a run the ceiling cut short; undefined when it ended on its own. */
  stoppedNote: () => string | undefined;
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
  return {
    recordStep: (step) => {
      spent += stepCostUsd(step, args.pricingModel);
    },
    stopIfCeilingReached: () => {
      if (args.ceilingUsd === undefined || spent < args.ceilingUsd) return false;
      stopped = true;
      return true;
    },
    spentUsd: () => spent,
    stoppedNote: () =>
      stopped ? `stopped at the cost ceiling after $${spent.toFixed(2)}` : undefined,
  };
}
