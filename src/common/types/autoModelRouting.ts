import { z } from "zod";
import { ThinkingLevelSchema } from "./thinking";
import { isValidModelFormat } from "@/common/utils/ai/models";
import {
  AUTO_MODEL_ROUTING_MAX_DESCRIPTION_CHARS,
  AUTO_MODEL_ROUTING_MAX_LABEL_CHARS,
  AUTO_MODEL_ROUTING_MAX_TIERS,
  AUTO_MODEL_ROUTING_MIN_TIERS,
} from "@/constants/autoModelRouting";

/**
 * Auto model routing (auto-model-routing experiment). The user defines ordered
 * difficulty tiers; TypeSafe's Jev picks one per prompt and the turn runs on
 * that tier's model. Field names deliberately avoid a bare `tier` (that name is
 * taken by AiSettingTier).
 */

/** Tier ids double as Jev choice keys, so they must be plain slugs. */
const TIER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export const AutoModelRoutingTierSchema = z.object({
  id: z.string().regex(TIER_ID_PATTERN),
  label: z.string().min(1).max(AUTO_MODEL_ROUTING_MAX_LABEL_CHARS),
  description: z.string().min(1).max(AUTO_MODEL_ROUTING_MAX_DESCRIPTION_CHARS),
  /** Canonical provider:model string; absent means "use the composer's model". */
  model: z.string().refine(isValidModelFormat).optional(),
  /** Absent means "inherit the composer's thinking level". */
  thinkingLevel: ThinkingLevelSchema.optional(),
});

export const AutoModelRoutingConfigSchema = z.object({
  tiers: z
    .array(AutoModelRoutingTierSchema)
    .min(AUTO_MODEL_ROUTING_MIN_TIERS)
    .max(AUTO_MODEL_ROUTING_MAX_TIERS),
});

export type AutoModelRoutingTier = z.infer<typeof AutoModelRoutingTierSchema>;
export type AutoModelRoutingConfig = z.infer<typeof AutoModelRoutingConfigSchema>;

export const DEFAULT_AUTO_MODEL_ROUTING_TIERS: readonly AutoModelRoutingTier[] = [
  {
    id: "easy",
    label: "Easy",
    description:
      "Trivial edits, renames, one-line fixes, lookups, or questions answerable from context",
  },
  {
    id: "medium",
    label: "Medium",
    description: "Small features or bug fixes touching a few files with a clear approach",
  },
  {
    id: "hard",
    label: "Hard",
    description: "Multi-file features, refactors, or debugging where the cause is unclear",
  },
  {
    id: "extreme",
    label: "Extreme",
    description:
      "Architecture or design work, ambiguous requirements, or large cross-cutting changes",
  },
];

export function getDefaultAutoModelRoutingConfig(): AutoModelRoutingConfig {
  return { tiers: DEFAULT_AUTO_MODEL_ROUTING_TIERS.map((tier) => ({ ...tier })) };
}

const RawTierListSchema = z.object({ tiers: z.array(z.unknown()) });

/**
 * Lenient-on-read normalization shared by config load and the Settings editor:
 * tiers with invalid ids, labels, descriptions, or models are dropped, duplicate
 * ids keep their first occurrence, the list is capped, and anything that leaves
 * fewer than the minimum falls back to the defaults.
 */
export function normalizeAutoModelRoutingConfig(value: unknown): AutoModelRoutingConfig {
  const tierList = RawTierListSchema.safeParse(value);
  const seen = new Set<string>();
  const tiers: AutoModelRoutingTier[] = [];
  for (const raw of tierList.success ? tierList.data.tiers : []) {
    const parsed = AutoModelRoutingTierSchema.safeParse(raw);
    if (!parsed.success || seen.has(parsed.data.id)) continue;
    seen.add(parsed.data.id);
    tiers.push(parsed.data);
    if (tiers.length >= AUTO_MODEL_ROUTING_MAX_TIERS) break;
  }
  return tiers.length >= AUTO_MODEL_ROUTING_MIN_TIERS
    ? { tiers }
    : getDefaultAutoModelRoutingConfig();
}

/** Classifier verdict for one prompt. */
export interface AutoModelRoutingDecision {
  tierId: string;
  confidence: number;
  probabilities: Record<string, number>;
  classifierModel: string;
}

/**
 * Persisted on the assistant message so the transcript can show which tier
 * Jev chose and why the turn ran on the model it did.
 */
export interface AutoModelRoutingRecord {
  /** The composer's concrete model, used whenever routing cannot pick one. */
  requestedFallbackModel: string;
  tierId?: string;
  tierLabel?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
  /** The model the turn actually ran on. */
  model: string;
  status: "routed" | "unmapped-tier" | "fallback";
  /** Sanitized classifier failure reason for the fallback status. */
  reason?: string;
}

export type AutoModelRoutingApiKeySource = "config" | "file" | "env" | "none";

export interface AutoModelRoutingClassifierStatus {
  apiKeySource: AutoModelRoutingApiKeySource;
}
