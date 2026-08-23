/**
 * Pure transform/validation logic for refreshing models.json from LiteLLM's
 * model_prices_and_context_window.json. The fetch/write CLI wrapper lives in
 * scripts/update_models.ts (run via `make update-models`); the logic lives here
 * so `bun test src` covers it (#3727).
 */

import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { modelsExtra } from "./models-extra";
import { generateModelLookupKeys, hasUsableTokenLimits } from "./modelStats";

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
// The absolute floor catches degenerate payloads; the relative bounds catch partial
// responses or field renames that would silently degrade thousands of known models.
const MIN_USABLE_MAPPABLE_MODELS = 500;
const MAX_BASELINE_SHRINK_FRACTION = 0.1;
// Relative checks only apply to baselines with enough entries for the fraction
// to be signal rather than noise (a 3-entry mode legitimately losing 1 entry
// must not block refreshes forever).
const MIN_BASELINE_FOR_SHRINK_CHECK = 20;
const MAX_INVALID_PRICING_FRACTION = 0.05;
// A poisoned upstream could keep every field present but scale prices toward
// zero (or absurdly high), silently corrupting cost accounting. Legitimate
// repricing moves few models or small factors, so a catalog-wide median shift
// beyond this factor is treated as corruption.
const MAX_MEDIAN_COST_SHIFT_FACTOR = 100;

/** Modes whose metadata applies to chat-style usage; mirrored by the Treat-as catalog. */
export const MAPPABLE_MODES = new Set(["chat", "responses"]);

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
 * Coverage uses getModelStats' own lookup keys and usability bar, so any key
 * form the runtime can resolve (bare, provider-scoped, models-extra override)
 * counts, and an entry that loses its token limits still counts as missing.
 */
export function findMissingKnownModels(
  catalog: ModelCatalogData,
  extra: Record<string, unknown> = modelsExtra
): string[] {
  const missing: string[] = [];
  for (const model of Object.values(KNOWN_MODELS)) {
    const covered = generateModelLookupKeys(model.id).some(
      (key) => providesUsableMetadata(catalog[key]) || providesUsableMetadata(extra[key])
    );
    if (!covered) {
      missing.push(model.id);
    }
  }
  return missing;
}

export interface ModeCoverage {
  /** Entries passing getModelStats' usability bar (usable token limits). */
  usable: number;
  /** Entries carrying a numeric input cost. */
  inputPriced: number;
  /** Entries carrying a numeric output cost. */
  outputPriced: number;
}

export interface CatalogSummary {
  totalEntries: number;
  /** Coverage per mode string, spanning every mode (not just mappable ones). */
  modes: Record<string, ModeCoverage>;
  /** Median positive per-token costs across mappable entries (0 when none). */
  medianInputCost: number;
  medianOutputCost: number;
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

export function summarizeCatalog(catalog: ModelCatalogData): CatalogSummary {
  const summary: CatalogSummary = {
    totalEntries: 0,
    modes: {},
    medianInputCost: 0,
    medianOutputCost: 0,
  };
  const inputCosts: number[] = [];
  const outputCosts: number[] = [];
  for (const metadata of Object.values(catalog)) {
    summary.totalEntries++;
    const mode = typeof metadata.mode === "string" ? metadata.mode : "unknown";
    const coverage = (summary.modes[mode] ??= { usable: 0, inputPriced: 0, outputPriced: 0 });
    // Usability applies getModelStats' bar: entries without usable token limits
    // never resolve, so losing max_input_tokens must register as shrinkage.
    if (hasUsableTokenLimits(metadata)) {
      coverage.usable++;
    }
    // Input and output pricing are tracked separately per mode so renaming one
    // cost field, or stripping pricing from a smaller mode like `responses`,
    // cannot hide behind another field's or a larger mode's coverage.
    if (typeof metadata.input_cost_per_token === "number") {
      coverage.inputPriced++;
      if (MAPPABLE_MODES.has(mode) && metadata.input_cost_per_token > 0) {
        inputCosts.push(metadata.input_cost_per_token);
      }
    }
    if (typeof metadata.output_cost_per_token === "number") {
      coverage.outputPriced++;
      if (MAPPABLE_MODES.has(mode) && metadata.output_cost_per_token > 0) {
        outputCosts.push(metadata.output_cost_per_token);
      }
    }
  }
  summary.medianInputCost = median(inputCosts);
  summary.medianOutputCost = median(outputCosts);
  return summary;
}

const EMPTY_BASELINE: CatalogSummary = {
  totalEntries: 0,
  modes: {},
  medianInputCost: 0,
  medianOutputCost: 0,
};

function belowBaseline(count: number, baseline: number): boolean {
  return (
    baseline >= MIN_BASELINE_FOR_SHRINK_CHECK &&
    count < Math.ceil(baseline * (1 - MAX_BASELINE_SHRINK_FRACTION))
  );
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
  const usableMappableModels = [...MAPPABLE_MODES].reduce(
    (count, mode) => count + (summary.modes[mode]?.usable ?? 0),
    0
  );
  if (usableMappableModels < MIN_USABLE_MAPPABLE_MODELS) {
    errors.push(
      `only ${usableMappableModels} usable chat/responses models found ` +
        `(expected at least ${MIN_USABLE_MAPPABLE_MODELS})`
    );
  }

  // Costs are optional per entry (subscription providers), so an upstream
  // pricing-field rename or a wholesale mode omission would sail through the
  // per-entry checks; comparing every mode's usable and priced coverage against
  // the vendored baseline (plus the total entry count for modes without usable
  // limits, like image_generation pricing rows) keeps getModelStats from
  // silently zero-pricing or dropping whole slices of the catalog.
  const shrinkChecks: Array<[label: string, count: number, baselineCount: number]> = [
    ["total entry count", summary.totalEntries, baseline.totalEntries],
  ];
  const emptyCoverage: ModeCoverage = { usable: 0, inputPriced: 0, outputPriced: 0 };
  for (const [mode, baselineCoverage] of Object.entries(baseline.modes)) {
    const coverage = summary.modes[mode] ?? emptyCoverage;
    shrinkChecks.push(
      [`${mode} usable model count`, coverage.usable, baselineCoverage.usable],
      [`${mode} input-priced model count`, coverage.inputPriced, baselineCoverage.inputPriced],
      [`${mode} output-priced model count`, coverage.outputPriced, baselineCoverage.outputPriced]
    );
  }
  for (const [label, count, baselineCount] of shrinkChecks) {
    if (belowBaseline(count, baselineCount)) {
      errors.push(
        `${label} shrank from ${baselineCount} to ${count} ` +
          `(more than ${MAX_BASELINE_SHRINK_FRACTION * 100}% below the vendored baseline)`
      );
    }
  }

  // Guard price magnitudes, not just field presence: a poisoned catalog could
  // retain every field while scaling all rates toward zero.
  const medianChecks: Array<[label: string, value: number, baselineValue: number]> = [
    ["median input cost", summary.medianInputCost, baseline.medianInputCost],
    ["median output cost", summary.medianOutputCost, baseline.medianOutputCost],
  ];
  for (const [label, value, baselineValue] of medianChecks) {
    if (value > 0 && baselineValue > 0) {
      const ratio = value / baselineValue;
      if (ratio > MAX_MEDIAN_COST_SHIFT_FACTOR || ratio < 1 / MAX_MEDIAN_COST_SHIFT_FACTOR) {
        errors.push(
          `${label} shifted from ${baselineValue} to ${value} (more than ` +
            `${MAX_MEDIAN_COST_SHIFT_FACTOR}x from the vendored baseline; possible price corruption)`
        );
      }
    }
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
