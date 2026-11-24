import type { ProviderModelEntry } from "@/common/orpc/types";
import { normalizeToCanonical } from "@/common/utils/ai/models";
import { resolveCoderGatewayMetadataModel } from "@/common/utils/providers/coderGatewayMetadata";

export type ProviderModelsConfig = Record<string, { models?: ProviderModelEntry[] } | undefined>;

interface ParsedProviderModelId {
  provider: string;
  modelId: string;
}

export function maybeGetProviderModelEntryId(entry: unknown): string | null {
  if (typeof entry === "string") {
    return parseModelId(entry);
  }

  if (
    typeof entry === "object" &&
    entry !== null &&
    typeof (entry as { id?: unknown }).id === "string"
  ) {
    return parseModelId((entry as { id: string }).id);
  }

  return null;
}

export function getProviderModelEntryId(entry: ProviderModelEntry): string {
  const modelId = maybeGetProviderModelEntryId(entry);
  if (modelId == null) {
    throw new Error("Invalid ProviderModelEntry");
  }
  return modelId;
}

export function getProviderModelEntryContextWindowTokens(entry: ProviderModelEntry): number | null {
  if (typeof entry === "string") {
    return null;
  }
  return entry.contextWindowTokens ?? null;
}

export function getProviderModelEntryMappedTo(entry: ProviderModelEntry): string | null {
  if (typeof entry === "string") {
    return null;
  }
  return entry.mappedToModel ?? null;
}

function parseProviderModelId(fullModelId: string): ParsedProviderModelId | null {
  const separatorIndex = fullModelId.indexOf(":");
  if (separatorIndex <= 0 || separatorIndex >= fullModelId.length - 1) {
    return null;
  }

  return {
    provider: fullModelId.slice(0, separatorIndex),
    modelId: fullModelId.slice(separatorIndex + 1),
  };
}

function findProviderModelEntry(
  providersConfig: ProviderModelsConfig | null,
  provider: string,
  modelId: string
): ProviderModelEntry | null {
  const entries = providersConfig?.[provider]?.models;
  if (!entries || entries.length === 0) {
    return null;
  }

  for (const entry of entries) {
    if (getProviderModelEntryId(entry) === modelId) {
      return entry;
    }
  }

  return null;
}

/**
 * Scoped-first provider model entry lookup.
 *
 * Checks the raw (possibly gateway-scoped) provider block first so
 * gateway-local overrides like contextWindowTokens and mappedToModel
 * take effect. Falls back to a canonical-identity lookup only when the
 * scoped lookup misses. For coder: identities the fallback identity is
 * TYPE-derived, never name-derived: {name: "openai", type: "anthropic"}
 * name-canonicalizes to openai:<model>, and consulting the direct OpenAI
 * block's entry would apply the wrong provider family's mappedToModel or
 * context-window override to an Anthropic-wire gateway model. Unmappable
 * or shadowed coder identities get no fallback — the raw scoped entry is
 * their only override source.
 */
function findProviderModelEntryScoped(
  fullModelId: string,
  providersConfig: ProviderModelsConfig | null
): ProviderModelEntry | null {
  const rawParsed = parseProviderModelId(fullModelId);
  if (rawParsed) {
    const scopedEntry = findProviderModelEntry(
      providersConfig,
      rawParsed.provider,
      rawParsed.modelId
    );
    if (scopedEntry) {
      return scopedEntry;
    }
  }

  const fallbackIdentity = fullModelId.startsWith("coder:")
    ? resolveCoderGatewayMetadataModel(fullModelId, providersConfig)
    : normalizeToCanonical(fullModelId);
  if (fallbackIdentity == null || fallbackIdentity === fullModelId) {
    return null;
  }

  const canonicalParsed = parseProviderModelId(fallbackIdentity);
  if (!canonicalParsed) {
    return null;
  }

  return findProviderModelEntry(providersConfig, canonicalParsed.provider, canonicalParsed.modelId);
}

export function getModelContextWindowOverride(
  fullModelId: string,
  providersConfig: ProviderModelsConfig | null
): number | null {
  const entry = findProviderModelEntryScoped(fullModelId, providersConfig);
  return entry ? getProviderModelEntryContextWindowTokens(entry) : null;
}

export function resolveModelForMetadata(
  fullModelId: string,
  providersConfig: ProviderModelsConfig | null
): string {
  const entry = findProviderModelEntryScoped(fullModelId, providersConfig);
  const mapped = entry ? getProviderModelEntryMappedTo(entry) : null;
  if (mapped != null) {
    // Explicit user override always wins.
    return mapped;
  }
  // Gateway-scoped Coder strings carry no catalog identity of their own:
  // pricing, context-window, and tokenizer lookups must target the
  // instance's upstream, derived from its provider type. Without this,
  // auto-discovered gateway models are unpriced (budgeted goals reject
  // them) and have unknown context limits (no limit-driven compaction).
  return resolveCoderGatewayMetadataModel(fullModelId, providersConfig) ?? fullModelId;
}

/**
 * Usage-ledger key for a model string. Same as normalizeToCanonical, except
 * Coder gateway identities resolve AT RECORD TIME to their durable priceable
 * identity via resolveModelForMetadata: an explicit scoped mappedToModel
 * ("Treat as") override wins, then the instance-type-derived upstream catalog
 * identity (coder:prod-anthropic/<claude> -> anthropic:<claude>). Repricing
 * (WorkspaceStore.repriceSessionUsage) sees ONLY this key: it cannot recover
 * a Coder-scoped mapping or a removed instance's type from a stored key, so
 * both must be applied before the key is persisted. Name-based
 * canonicalization is ruled out too — it keys a cross-typed instance
 * ({name: "openai", type: "anthropic"}) under openai:<claude>, so repricing
 * strips the recorded Anthropic costs as unknown OpenAI-model costs.
 * Unmappable identities (openai-compat instances, unknown instances, a
 * custom provider shadowing the "coder" prefix) keep the raw key — it is
 * their only durable identity.
 */
export function normalizeUsageModelKey(
  modelString: string,
  providersConfig?: ProviderModelsConfig | null
): string {
  if (modelString.startsWith("coder:")) {
    try {
      return resolveModelForMetadata(modelString, providersConfig ?? null);
    } catch {
      // Invalid model entries (hand-edited config) must not break usage
      // recording or live frontend deltas — fall back to the type-derived
      // identity (self-healing).
      return resolveCoderGatewayMetadataModel(modelString, providersConfig) ?? modelString;
    }
  }
  return normalizeToCanonical(modelString);
}

function parseModelId(rawValue: unknown): string | null {
  if (typeof rawValue !== "string") {
    return null;
  }

  const trimmed = rawValue.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseContextWindowTokens(rawValue: unknown): number | null {
  if (typeof rawValue !== "number" || !Number.isInteger(rawValue) || rawValue <= 0) {
    return null;
  }

  return rawValue;
}

export function normalizeProviderModelEntry(rawEntry: unknown): ProviderModelEntry | null {
  if (typeof rawEntry === "string") {
    const modelId = parseModelId(rawEntry);
    return modelId ?? null;
  }

  if (typeof rawEntry !== "object" || rawEntry === null) {
    return null;
  }

  const entry = rawEntry as {
    id?: unknown;
    contextWindowTokens?: unknown;
    mappedToModel?: unknown;
  };
  const modelId = parseModelId(entry.id);
  if (!modelId) {
    return null;
  }

  const contextWindowTokens = parseContextWindowTokens(entry.contextWindowTokens);
  const mappedToModel = parseModelId(entry.mappedToModel);
  if (contextWindowTokens === null && mappedToModel === null) {
    return modelId;
  }

  return {
    id: modelId,
    ...(contextWindowTokens !== null ? { contextWindowTokens } : {}),
    ...(mappedToModel !== null ? { mappedToModel } : {}),
  };
}

export function normalizeProviderModelEntries(rawEntries: unknown): ProviderModelEntry[] {
  if (!Array.isArray(rawEntries)) {
    return [];
  }

  const normalized: ProviderModelEntry[] = [];
  const seen = new Set<string>();

  for (const rawEntry of rawEntries) {
    const normalizedEntry = normalizeProviderModelEntry(rawEntry);
    if (!normalizedEntry) {
      continue;
    }

    const modelId = getProviderModelEntryId(normalizedEntry);
    if (seen.has(modelId)) {
      continue;
    }

    seen.add(modelId);
    normalized.push(normalizedEntry);
  }

  return normalized;
}

/**
 * MIGRATION-ONLY classifier for a coder section written by OLD code, whose
 * discovery merged the catalog into `models`: the entries that carry
 * user-managed data are everything NOT recorded in the catalog markers, plus
 * any object-form entry — normalization collapses override-free objects to
 * plain strings, so an object entry means the user edited it (context window
 * override, model mapping) even when its ID was discovered. Under the current
 * contract `models` is user-managed by construction, so no writer may apply
 * this classification to a flagged section (it would strip explicit adds of
 * catalog IDs); see separateDiscoveredModels.
 */
export function userManagedModelEntries(
  section: Record<string, unknown> | undefined
): ProviderModelEntry[] {
  if (!Array.isArray(section?.models)) {
    return [];
  }
  // Old code unioned the authoritative catalog with the stale marker
  // (entries it retained in `models` while the catalog was inconclusive), so
  // both are catalog provenance here.
  const discovered = new Set(
    [section.discoveredModels, section.staleDiscoveredModels].flatMap((value) =>
      Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []
    )
  );
  return normalizeProviderModelEntries(section.models).filter((entry) => {
    if (typeof entry !== "string") {
      return true; // User-authored settings on a (possibly discovered) model.
    }
    const id = maybeGetProviderModelEntryId(entry);
    return id == null || !discovered.has(id);
  });
}
