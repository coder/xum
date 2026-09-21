import { z } from "zod";
import { ThinkingLevelSchema, type ThinkingLevel } from "./thinking";
import { isValidModelFormat } from "@/common/utils/ai/models";
import {
  AUTO_MODEL_ROUTING_EVALUATION_PROVIDERS,
  AUTO_MODEL_ROUTING_MAX_DESCRIPTION_CHARS,
  AUTO_MODEL_ROUTING_MAX_LABEL_CHARS,
  AUTO_MODEL_ROUTING_MAX_TIERS,
  AUTO_MODEL_ROUTING_MIN_TIERS,
  DEFAULT_AUTO_MODEL_ROUTING_EVALUATION_MODEL,
  type AutoModelRoutingEvaluationProvider,
} from "@/constants/autoModelRouting";

/**
 * Auto model routing (auto-model-routing experiment). The user defines ordered
 * difficulty tiers; the user's evaluation model picks one per prompt and the turn
 * runs on that tier's model and/or thinking level, each dimension opted into
 * separately from the composer. Field names deliberately avoid a bare `tier`
 * (that name is taken by AiSettingTier).
 */

/** Tier ids double as evaluation choice keys, so they must be plain slugs. */
const TIER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function isAutoModelRoutingEvaluationProvider(
  provider: string
): provider is AutoModelRoutingEvaluationProvider {
  return (AUTO_MODEL_ROUTING_EVALUATION_PROVIDERS as readonly string[]).includes(provider);
}

/** Split `provider:model` at the first colon (model ids may contain colons). */
export function splitAutoModelRoutingEvaluationModel(value: string): {
  provider: string;
  modelId: string;
} {
  const colonIndex = value.indexOf(":");
  return { provider: value.slice(0, colonIndex), modelId: value.slice(colonIndex + 1) };
}

/** `provider:model` whose provider ships an AI SDK `evaluationModel()` factory. */
export function isAutoModelRoutingEvaluationModel(value: string): boolean {
  return (
    isValidModelFormat(value) &&
    isAutoModelRoutingEvaluationProvider(splitAutoModelRoutingEvaluationModel(value).provider)
  );
}

export const AutoModelRoutingTierSchema = z.object({
  id: z.string().regex(TIER_ID_PATTERN),
  // Trim before the length checks: a whitespace-only label or description would otherwise
  // pass min(1) and reach the evaluator as an empty criterion.
  label: z.string().trim().min(1).max(AUTO_MODEL_ROUTING_MAX_LABEL_CHARS),
  description: z.string().trim().min(1).max(AUTO_MODEL_ROUTING_MAX_DESCRIPTION_CHARS),
  /** Canonical provider:model string; absent means "use the composer's model". */
  model: z.string().refine(isValidModelFormat).optional(),
  /** Absent means "inherit the composer's thinking level". */
  thinkingLevel: ThinkingLevelSchema.optional(),
});

export const AutoModelRoutingEvaluationModelSchema = z
  .string()
  .refine(isAutoModelRoutingEvaluationModel);

export const AutoModelRoutingConfigSchema = z.object({
  tiers: z
    .array(AutoModelRoutingTierSchema)
    .min(AUTO_MODEL_ROUTING_MIN_TIERS)
    .max(AUTO_MODEL_ROUTING_MAX_TIERS),
  /**
   * The AI SDK evaluation model that classifies prompts, as `provider:model`.
   * Optional on the wire and on disk; normalized reads fill in the default.
   */
  evaluationModel: AutoModelRoutingEvaluationModelSchema.optional(),
});

export type AutoModelRoutingTier = z.infer<typeof AutoModelRoutingTierSchema>;
export type AutoModelRoutingConfigInput = z.infer<typeof AutoModelRoutingConfigSchema>;
/** Normalized config: the evaluation model is always present. */
export interface AutoModelRoutingConfig extends AutoModelRoutingConfigInput {
  evaluationModel: string;
}

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
  return {
    tiers: DEFAULT_AUTO_MODEL_ROUTING_TIERS.map((tier) => ({ ...tier })),
    evaluationModel: DEFAULT_AUTO_MODEL_ROUTING_EVALUATION_MODEL,
  };
}

/**
 * Lenient-on-read normalization shared by config load and the Settings editor:
 * tiers with invalid ids, labels, descriptions, or models are dropped, duplicate
 * ids keep their first occurrence, the list is capped, anything that leaves fewer
 * than the minimum falls back to the default tiers, and an unsupported evaluation
 * model falls back to the default evaluator.
 */
export function normalizeAutoModelRoutingConfig(value: unknown): AutoModelRoutingConfig {
  // Each field heals on its own: a damaged tier list must not discard a valid evaluator.
  const raw: { tiers?: unknown; evaluationModel?: unknown } =
    typeof value === "object" && value !== null ? value : {};
  const seen = new Set<string>();
  const tiers: AutoModelRoutingTier[] = [];
  for (const rawTier of Array.isArray(raw.tiers) ? raw.tiers : []) {
    const parsed = AutoModelRoutingTierSchema.safeParse(rawTier);
    if (!parsed.success || seen.has(parsed.data.id)) continue;
    seen.add(parsed.data.id);
    tiers.push(parsed.data);
    if (tiers.length >= AUTO_MODEL_ROUTING_MAX_TIERS) break;
  }
  const evaluationModel = AutoModelRoutingEvaluationModelSchema.safeParse(raw.evaluationModel);
  return {
    tiers:
      tiers.length >= AUTO_MODEL_ROUTING_MIN_TIERS
        ? tiers
        : getDefaultAutoModelRoutingConfig().tiers,
    evaluationModel: evaluationModel.success
      ? evaluationModel.data
      : DEFAULT_AUTO_MODEL_ROUTING_EVALUATION_MODEL,
  };
}

/** Which composer dimensions Auto may change for a turn. */
export interface AutoModelRoutingDimensions {
  /** Composer model set to Auto: run on the chosen tier's model. */
  model: boolean;
  /** Composer thinking level set to Auto: run on the chosen tier's thinking level. */
  thinkingLevel: boolean;
}

/** Evaluation verdict for one prompt. */
export interface AutoModelRoutingDecision {
  tierId: string;
  /** Provider-specific (TypeSafe reports one); absent for language-model evaluators. */
  confidence?: number;
  /** Distribution over tier ids when the evaluator reports one. */
  probabilities?: Record<string, number>;
  /** The `provider:model` that produced the verdict. */
  evaluationModel: string;
}

/**
 * Persisted on the assistant message so the transcript can show which tier the
 * evaluator chose and why the turn ran on the model and thinking level it did.
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
  /** Present when Auto set the thinking level; absent means the composer's level ran. */
  thinkingLevel?: ThinkingLevel;
  status: "routed" | "unmapped-tier" | "fallback";
  /** Sanitized evaluation failure reason for the fallback status. */
  reason?: string;
}

/** Whether the configured evaluation model can be built (credentials, policy); never the key. */
export interface AutoModelRoutingEvaluationStatus {
  evaluationModel: string;
  available: boolean;
  /** Why the evaluator is unavailable, phrased for the Settings status line. */
  reason?: string;
}
