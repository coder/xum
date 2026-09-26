import type { ModelStats } from "./modelStats";
import { resolveRawModelEntry } from "./modelStats";

/**
 * OpenAI service-tier pricing (#4352).
 *
 * The tier that decides the bill is the one the provider reports in the
 * response (`service_tier`, surfaced as `providerMetadata.openai.serviceTier`),
 * not the one we asked for: a project-level Fast default applies to requests
 * that send no tier, and the Fast ramp limit can downgrade a request to
 * Standard ("default", billed at standard rates). Source for everything below:
 * https://developers.openai.com/api/docs/pricing (Standard, Flex and Fast
 * tables) and https://developers.openai.com/api/docs/guides/fast-mode, both
 * fetched 2026-09-26.
 */
export type PricedServiceTier = "flex" | "standard" | "fast" | "unknown";

/** Maps a provider-reported tier to its price list; `undefined` means none was reported. */
export function normalizeOpenAIServiceTier(value: unknown): PricedServiceTier | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  switch (value) {
    // Priority was renamed Fast on 2026-07-30; GPT-5.6 and earlier still answer "priority".
    case "priority":
    case "fast":
      return "fast";
    case "flex":
      return "flex";
    // Scale Tier is prepaid capacity; Standard is its published per-token reference.
    // A response names the tier actually used, so "auto" is no information: Standard.
    case "default":
    case "scale":
    case "auto":
      return "standard";
    default:
      return "unknown";
  }
}

const KNOWN_OPENAI_SERVICE_TIERS: ReadonlySet<string> = new Set([
  "auto",
  "default",
  "flex",
  "priority",
  "fast",
  "scale",
]);

/** A reported tier value that is safe to persist verbatim (no provider free text). */
export function isKnownOpenAIServiceTier(value: unknown): value is string {
  return typeof value === "string" && KNOWN_OPENAI_SERVICE_TIERS.has(value);
}

const TIER_COST_RANK: Record<PricedServiceTier, number> = {
  flex: 0,
  standard: 1,
  fast: 2,
  unknown: 3,
};

/** Orders reported tiers by what they can cost; an absent tier ranks lowest. */
export function serviceTierCostRank(value: unknown): number {
  const tier = normalizeOpenAIServiceTier(value);
  return tier === undefined ? -1 : TIER_COST_RANK[tier];
}

interface TierFactor {
  /** Published tier rate = factor × the model's Standard rate, for every token class. */
  readonly factor: number;
  /** Whether the tier publishes long-context rates for this model. */
  readonly longContext: boolean;
}

const HALF_BOTH_BANDS: TierFactor = { factor: 0.5, longContext: true };
const HALF_SHORT_ONLY: TierFactor = { factor: 0.5, longContext: false };
const DOUBLE_BOTH_BANDS: TierFactor = { factor: 2, longContext: true };
const fastShortOnly = (factor: number): TierFactor => ({ factor, longContext: false });

/**
 * Factors reproduce every published Flex/Fast cell from the model's Standard
 * rates (the page rounds a few cells, e.g. gpt-5.4 Flex cached shows $0.13 for
 * 0.5 × $0.25). Factors rather than copied rate cards so a Standard change,
 * like the end of gpt-5.6-sol's promotion, carries over ("Fast mode costs twice
 * the corresponding Standard rate"). Keys are the bare catalog keys the model's
 * Standard stats resolve from.
 */
const OPENAI_SERVICE_TIER_FACTORS: Readonly<
  Record<string, Partial<Record<"flex" | "fast", TierFactor>>>
> = {
  "gpt-6-astra": { flex: HALF_BOTH_BANDS, fast: DOUBLE_BOTH_BANDS },
  "gpt-6-sol": { flex: HALF_BOTH_BANDS, fast: DOUBLE_BOTH_BANDS },
  "gpt-6-luna": { flex: HALF_BOTH_BANDS, fast: DOUBLE_BOTH_BANDS },
  "gpt-5.6-sol": { flex: HALF_BOTH_BANDS, fast: DOUBLE_BOTH_BANDS },
  "gpt-5.6-terra": { flex: HALF_BOTH_BANDS, fast: DOUBLE_BOTH_BANDS },
  "gpt-5.6-luna": { flex: HALF_BOTH_BANDS, fast: DOUBLE_BOTH_BANDS },
  "gpt-5.5": { flex: HALF_BOTH_BANDS, fast: fastShortOnly(2.5) },
  "gpt-5.5-pro": { flex: HALF_SHORT_ONLY },
  "gpt-5.4": { flex: HALF_BOTH_BANDS, fast: fastShortOnly(2) },
  "gpt-5.4-pro": { flex: HALF_BOTH_BANDS },
  "gpt-5.4-mini": { flex: HALF_SHORT_ONLY, fast: fastShortOnly(2) },
  "gpt-5.4-nano": { flex: HALF_SHORT_ONLY },
  "gpt-5.3-codex": { fast: fastShortOnly(2) },
  "gpt-5.2": { flex: HALF_SHORT_ONLY, fast: fastShortOnly(2) },
  "gpt-5.1": { flex: HALF_SHORT_ONLY, fast: fastShortOnly(2) },
  "gpt-5": { flex: HALF_SHORT_ONLY, fast: fastShortOnly(2) },
  "gpt-5-mini": { flex: HALF_SHORT_ONLY, fast: fastShortOnly(1.8) },
  "gpt-5-nano": { flex: HALF_SHORT_ONLY },
  o3: { flex: HALF_SHORT_ONLY, fast: fastShortOnly(1.75) },
  "o4-mini": { flex: HALF_SHORT_ONLY, fast: fastShortOnly(20 / 11) },
  "gpt-4.1": { fast: fastShortOnly(1.75) },
  "gpt-4.1-mini": { fast: fastShortOnly(1.75) },
  "gpt-4.1-nano": { fast: fastShortOnly(2) },
  "gpt-4o": { fast: fastShortOnly(1.7) },
  "gpt-4o-2024-05-13": { fast: fastShortOnly(1.75) },
  "gpt-4o-mini": { fast: fastShortOnly(5 / 3) },
};

function lookupTierFactors(
  modelString: string
): Partial<Record<"flex" | "fast", TierFactor>> | undefined {
  const key = resolveRawModelEntry(modelString)?.key.replace(/^openai\//, "");
  if (key === undefined) {
    return undefined;
  }
  return (
    OPENAI_SERVICE_TIER_FACTORS[key] ??
    OPENAI_SERVICE_TIER_FACTORS[key.replace(/-\d{4}-\d{2}-\d{2}$/, "")]
  );
}

/** Short-context rate fields paired with their long-context counterparts. */
const RATE_FIELDS = [
  ["input_cost_per_token", "input_cost_per_token_above_200k_tokens"],
  ["output_cost_per_token", "output_cost_per_token_above_200k_tokens"],
  ["cache_read_input_token_cost", "cache_read_input_token_cost_above_200k_tokens"],
  ["cache_creation_input_token_cost", "cache_creation_input_token_cost_above_200k_tokens"],
] as const;

/**
 * Scales the published cells. Only fields the Standard stats define are
 * touched, so an absent cache or long-context rate stays absent. An
 * unpublished long-context cell keeps the Standard long rate for Flex (Flex is
 * documented as cheaper than Standard) and takes the higher of the scaled
 * short rate and the Standard long rate for Fast.
 */
function scaleRates(stats: ModelStats, tier: "flex" | "fast", published: TierFactor): ModelStats {
  const scaled: ModelStats = { ...stats };
  for (const [short, long] of RATE_FIELDS) {
    const shortRate = stats[short];
    const longRate = stats[long];
    if (shortRate !== undefined) {
      scaled[short] = shortRate * published.factor;
    }
    if (longRate !== undefined) {
      scaled[long] = published.longContext
        ? longRate * published.factor
        : tier === "flex"
          ? longRate
          : Math.max(longRate, (shortRate ?? 0) * published.factor);
    }
  }
  return scaled;
}

/** Per token class, the highest rate across every given card and band. */
function highestPublishedRates(cards: readonly ModelStats[]): ModelStats {
  const highest: ModelStats = { ...cards[0] };
  for (const [short, long] of RATE_FIELDS) {
    const rates = cards.flatMap((card) => [card[short], card[long]]);
    const defined = rates.filter((rate): rate is number => rate !== undefined);
    if (defined.length === 0) continue;
    const max = Math.max(...defined);
    highest[short] = max;
    if (highest[long] !== undefined) {
      highest[long] = max;
    }
  }
  return highest;
}

/**
 * Returns the rates for `tier`. Budget rule for cells OpenAI does not publish
 * (#4352 plan): charge the model's highest published rate rather than refuse
 * dispatch, because the billed tier is only known after the response. Every
 * fallback errs toward over-counting and never yields an unknown cost.
 */
export function withServiceTierPricing(
  stats: ModelStats,
  modelString: string,
  tier: PricedServiceTier
): ModelStats {
  if (tier === "standard") {
    return stats;
  }
  const factors = lookupTierFactors(modelString);
  if (tier === "flex") {
    return factors?.flex !== undefined ? scaleRates(stats, "flex", factors.flex) : stats;
  }
  const fastCard =
    factors?.fast !== undefined ? scaleRates(stats, "fast", factors.fast) : undefined;
  if (tier === "fast" && fastCard !== undefined) {
    return fastCard;
  }
  // Fast without published rates, or a tier we do not know.
  return highestPublishedRates(fastCard !== undefined ? [stats, fastCard] : [stats]);
}
