/**
 * Full catalog of model ids usable as custom-model metadata mapping targets
 * ("Treat as" in Settings). Exposes every models.json entry with usable
 * chat metadata instead of only the curated KNOWN_MODELS list (#3727).
 */

import { KNOWN_MODELS } from "@/common/constants/knownModels";
import modelsData from "./models.json";
import { getModelStats } from "./modelStats";

// Only modes whose metadata (pricing, context window) applies to chat-style usage.
const MAPPABLE_MODES = new Set(["chat", "responses"]);

function toCanonicalModelId(catalogKey: string, metadata: Record<string, unknown>): string | null {
  // LiteLLM keys are either "provider/model" or a bare model id whose provider
  // lives in litellm_provider. Both canonical forms round-trip through
  // getModelStats: generateLookupKeys tries "provider/model" first and the bare
  // model name as a fallback.
  const slashIndex = catalogKey.indexOf("/");
  if (slashIndex > 0) {
    return `${catalogKey.slice(0, slashIndex)}:${catalogKey.slice(slashIndex + 1)}`;
  }
  const provider = metadata.litellm_provider;
  return typeof provider === "string" && provider.length > 0 ? `${provider}:${catalogKey}` : null;
}

let cachedIds: string[] | undefined;

/**
 * Canonical `provider:model` ids for every catalog entry with resolvable model
 * stats, unioned with the curated KNOWN_MODELS ids. Sorted. Cached because
 * models.json is static for the process lifetime.
 */
export function listModelCatalogIds(): string[] {
  if (cachedIds === undefined) {
    const ids = new Set<string>();
    for (const model of Object.values(KNOWN_MODELS)) {
      ids.add(model.id);
    }
    for (const [key, metadata] of Object.entries(
      modelsData as Record<string, Record<string, unknown>>
    )) {
      if (typeof metadata.mode !== "string" || !MAPPABLE_MODES.has(metadata.mode)) {
        continue;
      }
      const id = toCanonicalModelId(key, metadata);
      // getModelStats enforces the validity bar (usable token limits), so every
      // listed id inherits real metadata when selected as a mapping target.
      if (id === null || getModelStats(id) === null) {
        continue;
      }
      ids.add(id);
    }
    cachedIds = [...ids].sort();
  }
  return cachedIds;
}
