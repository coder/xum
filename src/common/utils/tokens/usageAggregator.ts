/**
 * Usage aggregation utilities for cost calculation
 *
 * IMPORTANT: This file must NOT import tokenizer to avoid pulling
 * 2MB+ of encoding data into the renderer process.
 *
 * Separated from tokenStatsCalculator.ts to keep tokenizer in main process only.
 */

export interface ChatUsageComponent {
  tokens: number;
  cost_usd?: number; // undefined if model pricing unknown
}

/**
 * Tokens of the requests whose prompt crossed the pricing model's long-context threshold.
 * Providers choose the tier per request, so usage summed over several requests prices this
 * share at long-context rates and the rest at base rates. `output` includes reasoning: steps
 * do not always report reasoning on its own.
 */
export interface LongContextTokens {
  input: number;
  cached: number;
  cacheCreate: number;
  cacheCreate1h: number;
  output: number;
}

export const NO_LONG_CONTEXT_TOKENS: LongContextTokens = {
  input: 0,
  cached: 0,
  cacheCreate: 0,
  cacheCreate1h: 0,
  output: 0,
};

export function addLongContextTokens(
  a: LongContextTokens,
  b: LongContextTokens
): LongContextTokens {
  return {
    input: a.input + b.input,
    cached: a.cached + b.cached,
    cacheCreate: a.cacheCreate + b.cacheCreate,
    cacheCreate1h: a.cacheCreate1h + b.cacheCreate1h,
    output: a.output + b.output,
  };
}

/**
 * Bounds a long-context share by the usage it belongs to (`totals`, all of its tokens), so a
 * malformed share cannot price more tokens than the usage has. The 1h part also stays within
 * the usage's 1h writes, and the 5m part within its 5m writes.
 */
export function clampLongContextTokens(
  share: LongContextTokens,
  totals: LongContextTokens
): LongContextTokens {
  const bound = (value: number, max: number) => Math.min(Math.max(0, value), max);
  const cacheCreate = bound(share.cacheCreate, totals.cacheCreate);
  return {
    input: bound(share.input, totals.input),
    cached: bound(share.cached, totals.cached),
    cacheCreate,
    cacheCreate1h: Math.max(
      bound(share.cacheCreate1h, Math.min(totals.cacheCreate1h, cacheCreate)),
      cacheCreate - (totals.cacheCreate - totals.cacheCreate1h)
    ),
    output: bound(share.output, totals.output),
  };
}

/**
 * Enhanced usage type for display that includes provider-specific cache stats
 */
export interface ChatUsageDisplay {
  // Input is the part of the input that was not cached. So,
  // totalInput = input + cached (cacheCreate is separate for billing)
  input: ChatUsageComponent;
  cached: ChatUsageComponent;
  cacheCreate: ChatUsageComponent; // Cache creation tokens (separate billing concept)
  // Share of cacheCreate.tokens Anthropic wrote at the 1h TTL (billed 2x input instead
  // of 1.25x). Absent when no response reported a 1h split.
  cacheCreate1hTokens?: number;

  // Output is the part of the output excluding reasoning, so
  // totalOutput = output + reasoning
  output: ChatUsageComponent;
  reasoning: ChatUsageComponent;

  // Optional model field for display purposes (context window calculation, etc.)
  model?: string;

  // True if any model in the sum had unknown pricing (costs are partial/incomplete)
  hasUnknownCosts?: boolean;

  // True when costs were explicitly zeroed because the provider gateway includes
  // billing (providerMetadata.mux.costsIncluded). These entries should not be
  // repriced when model mappings change.
  costsIncluded?: boolean;

  // OpenAI service tier the costs were priced at, so repricing keeps a Fast or Flex
  // premium (#4787). Absent means Standard; "mixed" marks a sum across tiers.
  serviceTier?: ChatUsageServiceTier;

  // Share priced at long-context rates, so repricing keeps each request's context tier.
  // Set for models with tiered pricing; a sum keeps it only when every entry has it.
  longContextTokens?: LongContextTokens;
}

export type ChatUsageServiceTier = "flex" | "fast" | "ultrafast" | "unknown" | "mixed";

/** The usage's 1h-TTL write share, clamped into [0, cacheCreate tokens]; malformed counts 0. */
export function getCacheCreate1hTokens(usage: ChatUsageDisplay): number {
  const share = usage.cacheCreate1hTokens ?? 0;
  return Number.isFinite(share) ? Math.min(usage.cacheCreate.tokens, Math.max(0, share)) : 0;
}

/** All of the usage's tokens, in the shape of a long-context share. */
export function getUsageTokenTotals(usage: ChatUsageDisplay): LongContextTokens {
  return {
    input: usage.input.tokens,
    cached: usage.cached.tokens,
    cacheCreate: usage.cacheCreate.tokens,
    cacheCreate1h: getCacheCreate1hTokens(usage),
    output: usage.output.tokens + usage.reasoning.tokens,
  };
}

/** The usage's long-context share bounded by its tokens; undefined when it has none. */
export function getLongContextTokens(usage: ChatUsageDisplay): LongContextTokens | undefined {
  return usage.longContextTokens === undefined
    ? undefined
    : clampLongContextTokens(usage.longContextTokens, getUsageTokenTotals(usage));
}

function sumLongContextTokens(usageHistory: ChatUsageDisplay[]): LongContextTokens | undefined {
  let total = NO_LONG_CONTEXT_TOKENS;
  for (const usage of usageHistory) {
    const share = getLongContextTokens(usage);
    if (share === undefined) return undefined;
    total = addLongContextTokens(total, share);
  }
  return total;
}

/**
 * Sum multiple ChatUsageDisplay objects into a single cumulative display
 * Used for showing total costs across multiple API responses
 */
export function sumUsageHistory(usageHistory: ChatUsageDisplay[]): ChatUsageDisplay | undefined {
  if (usageHistory.length === 0) return undefined;

  // Track if any entry already knows its costs are incomplete/approximate.
  let hasIncompleteCosts = false;
  // Track if any entry is gateway-billed (costs explicitly zeroed).
  // If even one entry was costsIncluded, the aggregated bucket should not be
  // repriced during mapping changes — we can't separate which tokens were billed
  // by the gateway vs. which were priced from model metadata.
  let anyCostsIncluded = false;
  const serviceTiers = new Set<ChatUsageServiceTier | "standard">();
  let cacheCreate1hTokens = 0;

  const sum: ChatUsageDisplay = {
    input: { tokens: 0, cost_usd: 0 },
    cached: { tokens: 0, cost_usd: 0 },
    cacheCreate: { tokens: 0, cost_usd: 0 },
    output: { tokens: 0, cost_usd: 0 },
    reasoning: { tokens: 0, cost_usd: 0 },
  };

  for (const usage of usageHistory) {
    if (usage.costsIncluded) anyCostsIncluded = true;
    if (usage.hasUnknownCosts) hasIncompleteCosts = true;
    serviceTiers.add(usage.serviceTier ?? "standard");
    // Clamp each entry's share to its own writes: a malformed persisted share must not claim
    // later 5m writes of the same aggregate (the backend sums rows without repricing them first).
    cacheCreate1hTokens += getCacheCreate1hTokens(usage);
    // Iterate over each component and sum tokens and costs
    const componentKeys: Array<"input" | "cached" | "cacheCreate" | "output" | "reasoning"> = [
      "input",
      "cached",
      "cacheCreate",
      "output",
      "reasoning",
    ];
    for (const key of componentKeys) {
      sum[key].tokens += usage[key].tokens;
      if (usage[key].cost_usd === undefined) {
        hasIncompleteCosts = true;
      } else {
        sum[key].cost_usd = (sum[key].cost_usd ?? 0) + (usage[key].cost_usd ?? 0);
      }
    }
  }

  if (cacheCreate1hTokens > 0) {
    sum.cacheCreate1hTokens = cacheCreate1hTokens;
  }
  const longContextTokens = sumLongContextTokens(usageHistory);
  if (longContextTokens !== undefined) {
    sum.longContextTokens = longContextTokens;
  }
  // Flag if any costs were incomplete/unknown (partial/inaccurate total)
  if (hasIncompleteCosts) {
    sum.hasUnknownCosts = true;
  }
  // Preserve costsIncluded when any entry in the sum was gateway-billed.
  // Mixed buckets (some costsIncluded, some not) cannot be safely repriced
  // because we can't separate which tokens were billed by the gateway.
  if (anyCostsIncluded) {
    sum.costsIncluded = true;
  }
  // One tier across the sum keeps it repriceable at that tier; several cannot be separated.
  const [onlyTier] = serviceTiers;
  const serviceTier = serviceTiers.size > 1 ? "mixed" : onlyTier;
  if (serviceTier !== undefined && serviceTier !== "standard") {
    sum.serviceTier = serviceTier;
  }

  return sum;
}

/**
 * Calculate total cost from a ChatUsageDisplay object.
 * Returns undefined if no cost data is available.
 */
export function getTotalCost(usage: ChatUsageDisplay | undefined): number | undefined {
  if (!usage) return undefined;
  const components = ["input", "cached", "cacheCreate", "output", "reasoning"] as const;
  let total = 0;
  let hasAnyCost = false;
  for (const key of components) {
    const cost = usage[key].cost_usd;
    if (cost !== undefined) {
      total += cost;
      hasAnyCost = true;
    }
  }
  return hasAnyCost ? total : undefined;
}

/**
 * Format cost for display with dollar sign.
 * Returns "~$0.00" for very small values, "$X.XX" otherwise.
 */
export function formatCostWithDollar(cost: number | undefined): string {
  if (cost === undefined) return "";
  if (cost === 0) return "$0.00";
  if (cost < 0.01) return "~$0.00";
  return `$${cost.toFixed(2)}`;
}
