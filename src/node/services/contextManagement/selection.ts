import { EXPERIMENT_IDS, type ExperimentId } from "@/common/constants/experiments";
import type { SendMessageOptions } from "@/common/orpc/types";
import { isRlmModeEnabled } from "../branchSummary";

export interface ContextStrategySelection {
  configured: "summarize" | "continuous" | "token-budget";
  tokenBudgetSuppressedBy?: "continuous" | "rlm" | "compaction-request";
}

/** Resolve configuration only; lifecycle eligibility and pending work stay with each hook. */
export function resolveContextStrategy(input: {
  experiments?: SendMessageOptions["experiments"];
  isEnabled: (id: ExperimentId) => boolean;
  isCompactionRequest: boolean;
}): ContextStrategySelection {
  const tokenBudget =
    input.experiments?.tokenBudget ?? input.isEnabled(EXPERIMENT_IDS.TOKEN_BUDGET);
  const continuous =
    input.experiments?.continuousCompaction ??
    input.isEnabled(EXPERIMENT_IDS.CONTINUOUS_COMPACTION);
  const configured = continuous ? "continuous" : tokenBudget ? "token-budget" : "summarize";

  if (!tokenBudget) return { configured };
  // Keep precedence and suppression separate: saved token-budget settings can be inactive,
  // and consumed continuous work must not disappear when the configured strategy changes.
  if (continuous) return { configured, tokenBudgetSuppressedBy: "continuous" };
  if (isRlmModeEnabled(input.experiments, input.isEnabled)) {
    return { configured, tokenBudgetSuppressedBy: "rlm" };
  }
  if (input.isCompactionRequest) {
    return { configured, tokenBudgetSuppressedBy: "compaction-request" };
  }
  return { configured };
}
