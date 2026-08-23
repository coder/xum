/**
 * Pure transform/validation logic for refreshing models.json from LiteLLM's
 * model_prices_and_context_window.json. The fetch/write CLI wrapper lives in
 * scripts/update_models.ts (run via `make update-models`); the logic lives here
 * so `bun test src` covers it (#3727).
 */

import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { modelsExtra } from "./models-extra";
import { hasUsableTokenLimits } from "./modelStats";

const RETAINED_FIELDS = [
  "max_input_tokens",
  "max_output_tokens",
  "input_cost_per_token",
  "output_cost_per_token",
  "output_cost_per_image_token",
  "input_cost_per_token_above_200k_tokens",
  "output_cost_per_token_above_200k_tokens",
  "cache_creation_input_token_cost",
  "cache_creation_input_token_cost_above_200k_tokens",
  "cache_read_input_token_cost",
  "cache_read_input_token_cost_above_200k_tokens",
  "tiered_pricing_threshold_tokens",
  "mode",
  "litellm_provider",
  "supports_pdf_input",
  "supports_vision",
  "supports_audio_input",
  "supports_video_input",
  "max_pdf_size_mb",
] as const;

const COST_FIELDS = [
  "input_cost_per_token",
  "output_cost_per_token",
  "output_cost_per_image_token",
  "input_cost_per_token_above_200k_tokens",
  "output_cost_per_token_above_200k_tokens",
  "cache_creation_input_token_cost",
  "cache_creation_input_token_cost_above_200k_tokens",
  "cache_read_input_token_cost",
  "cache_read_input_token_cost_above_200k_tokens",
] as const;

// Abort thresholds guarding against truncated or structurally reshaped upstream data.
// The absolute floor catches degenerate payloads; the relative bound catches partial
// responses that would silently drop metadata for thousands of currently known models.
const MIN_CHAT_MODELS = 500;
const MAX_CHAT_MODEL_SHRINK_FRACTION = 0.1;
const MAX_INVALID_PRICING_FRACTION = 0.05;

export type ModelCatalogData = Record<string, Record<string, unknown>>;

export interface SanitizedModelData {
  catalog: ModelCatalogData;
  /** Catalog keys dropped because a present cost field was not a finite non-negative number. */
  droppedModelIds: string[];
}

export function pruneModelData(data: unknown): ModelCatalogData {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Expected LiteLLM model metadata object");
  }

  const pruned: ModelCatalogData = {};
  for (const [modelId, rawMetadata] of Object.entries(data)) {
    if (!rawMetadata || typeof rawMetadata !== "object" || Array.isArray(rawMetadata)) {
      continue;
    }

    const metadata = rawMetadata as Record<string, unknown>;
    const retained: Record<string, unknown> = {};
    // Keep models.json small: Xum only reads pricing, token limits, provider, mode, and media
    // capability fields, while upstream LiteLLM ships many provider-specific fields we never use.
    for (const field of RETAINED_FIELDS) {
      if (metadata[field] !== undefined) {
        retained[field] = metadata[field];
      }
    }
    pruned[modelId] = retained;
  }

  return pruned;
}

function hasValidPricing(metadata: Record<string, unknown>): boolean {
  return COST_FIELDS.every((field) => {
    const value = metadata[field];
    // Absent costs are fine (e.g. subscription providers); present costs must be
    // usable numbers, otherwise cost tracking would silently misprice the model.
    return (
      value === undefined || (typeof value === "number" && Number.isFinite(value) && value >= 0)
    );
  });
}

export function sanitizePricing(pruned: ModelCatalogData): SanitizedModelData {
  const catalog: ModelCatalogData = {};
  const droppedModelIds: string[] = [];

  for (const [modelId, metadata] of Object.entries(pruned)) {
    if (hasValidPricing(metadata)) {
      catalog[modelId] = metadata;
    } else {
      droppedModelIds.push(modelId);
    }
  }

  return { catalog, droppedModelIds };
}

function providesUsableMetadata(entry: unknown): boolean {
  return (
    typeof entry === "object" &&
    entry !== null &&
    hasUsableTokenLimits(entry as Record<string, unknown>)
  );
}

/**
 * Curated models that would lose token/pricing metadata under the given catalog.
 * The models-extra overrides are consulted the same way getModelStats does, and
 * coverage requires usable metadata (not mere key presence), so an upstream entry
 * that loses its token limits still counts as missing.
 */
export function findMissingKnownModels(
  catalog: ModelCatalogData,
  extra: Record<string, unknown> = modelsExtra
): string[] {
  const missing: string[] = [];
  for (const model of Object.values(KNOWN_MODELS)) {
    const modelId = model.providerModelId;
    // xAI and Moonshot models are provider-prefixed in token metadata.
    const lookupKey =
      model.provider === "xai" || model.provider === "moonshotai"
        ? `${model.provider}/${modelId}`
        : modelId;
    if (
      !providesUsableMetadata(catalog[lookupKey]) &&
      !providesUsableMetadata(extra[lookupKey]) &&
      !providesUsableMetadata(extra[modelId])
    ) {
      missing.push(model.id);
    }
  }
  return missing;
}

export interface CatalogSummary {
  chatModels: number;
  /** Chat models carrying a numeric input or output cost. */
  pricedChatModels: number;
}

export function summarizeCatalog(catalog: ModelCatalogData): CatalogSummary {
  let chatModels = 0;
  let pricedChatModels = 0;
  for (const metadata of Object.values(catalog)) {
    if (metadata.mode !== "chat") {
      continue;
    }
    chatModels++;
    if (
      typeof metadata.input_cost_per_token === "number" ||
      typeof metadata.output_cost_per_token === "number"
    ) {
      pricedChatModels++;
    }
  }
  return { chatModels, pricedChatModels };
}

const EMPTY_BASELINE: CatalogSummary = { chatModels: 0, pricedChatModels: 0 };

function belowBaseline(count: number, baseline: number): boolean {
  return count < Math.ceil(baseline * (1 - MAX_CHAT_MODEL_SHRINK_FRACTION));
}

/**
 * Throws when the sanitized upstream data is unfit to replace the vendored
 * models.json. `baseline` summarizes the currently vendored catalog (defaults
 * to empty when unavailable, disabling the relative checks).
 */
export function validateModelData(
  sanitized: SanitizedModelData,
  baseline: CatalogSummary = EMPTY_BASELINE
): void {
  const { catalog, droppedModelIds } = sanitized;
  const errors: string[] = [];

  const summary = summarizeCatalog(catalog);
  if (summary.chatModels < MIN_CHAT_MODELS) {
    errors.push(
      `only ${summary.chatModels} chat models found (expected at least ${MIN_CHAT_MODELS})`
    );
  }
  if (belowBaseline(summary.chatModels, baseline.chatModels)) {
    errors.push(
      `chat model count shrank from ${baseline.chatModels} to ${summary.chatModels} ` +
        `(more than ${MAX_CHAT_MODEL_SHRINK_FRACTION * 100}% below the vendored baseline)`
    );
  }
  // Costs are optional per entry (subscription providers), so an upstream
  // pricing-field rename would sail through the per-entry checks; catching a
  // collapse in priced coverage keeps getModelStats from silently zero-pricing
  // the whole catalog.
  if (belowBaseline(summary.pricedChatModels, baseline.pricedChatModels)) {
    errors.push(
      `priced chat model count shrank from ${baseline.pricedChatModels} to ` +
        `${summary.pricedChatModels} (upstream pricing fields may have been renamed)`
    );
  }

  const total = Object.keys(catalog).length + droppedModelIds.length;
  if (total > 0 && droppedModelIds.length / total > MAX_INVALID_PRICING_FRACTION) {
    errors.push(
      `${droppedModelIds.length}/${total} entries have invalid pricing ` +
        `(e.g. ${droppedModelIds.slice(0, 5).join(", ")})`
    );
  }

  const missingKnownModels = findMissingKnownModels(catalog);
  if (missingKnownModels.length > 0) {
    errors.push(`curated known models missing from upstream: ${missingKnownModels.join(", ")}`);
  }

  if (errors.length > 0) {
    throw new Error(`Refusing to update models.json:\n- ${errors.join("\n- ")}`);
  }
}

export function serializeModelData(catalog: ModelCatalogData): string {
  // Sort keys so upstream object reordering never shows up as a diff (the CLI
  // and the scheduled workflow treat byte-identical output as "no update").
  const sorted = Object.fromEntries(
    Object.entries(catalog).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  );
  return `${JSON.stringify(sorted, null, 2)}\n`;
}
