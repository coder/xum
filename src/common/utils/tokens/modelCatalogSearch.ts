/**
 * Search/paging over the bundled model catalogue (listModelCatalogIds), backing
 * providers.searchModelCatalog. Lets users find and add models that newer
 * built-ins replaced (e.g. anthropic:claude-fable-5) without knowing the exact
 * provider model ID.
 */

import { KNOWN_MODELS } from "@/common/constants/knownModels";
import {
  CUSTOM_MODEL_HIDDEN_PROVIDERS,
  PROVIDER_DISPLAY_NAMES,
  isValidProvider,
} from "@/common/constants/providers";
import type {
  ModelCatalogEntry,
  ModelCatalogSearchInput,
  ModelCatalogSearchResult,
} from "@/common/orpc/types";
import { formatModelDisplayName } from "@/common/utils/ai/modelDisplay";
import { listModelCatalogIds } from "./modelCatalog";
import { PROVIDER_KEY_ALIASES, getModelStats } from "./modelStats";

/** Lowercased whitespace-separated query tokens; empty for a blank query. */
export function tokenizeModelQuery(query: string | undefined): string[] {
  return (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
}

/** True when every token is a substring of at least one (lowercased) field. */
export function matchesModelQueryTokens(tokens: string[], fields: readonly string[]): boolean {
  return tokens.every((token) => fields.some((field) => field.includes(token)));
}

interface IndexedCatalogEntry {
  entry: ModelCatalogEntry;
  /** Lowercased fields any token may match. */
  fields: string[];
  /** Lowercased fields that rank exact/prefix matches. */
  names: string[];
}

// Catalogue rows use LiteLLM provider names; only those naming a Xum provider
// (directly or via the stats lookup alias) are addable as custom models.
const XUM_PROVIDER_BY_CATALOG_PROVIDER = new Map(
  Object.entries(PROVIDER_KEY_ALIASES).map(([xum, litellm]) => [litellm, xum])
);

const BUILT_IN_BY_ID = new Map<string, (typeof KNOWN_MODELS)[keyof typeof KNOWN_MODELS]>(
  Object.values(KNOWN_MODELS).map((model) => [model.id, model])
);

let cachedIndex: IndexedCatalogEntry[] | undefined;

function getCatalogIndex(): IndexedCatalogEntry[] {
  if (cachedIndex !== undefined) {
    return cachedIndex;
  }
  const index: IndexedCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const catalogId of listModelCatalogIds()) {
    const colonIndex = catalogId.indexOf(":");
    const catalogProvider = catalogId.slice(0, colonIndex);
    const providerModelId = catalogId.slice(colonIndex + 1);
    const provider = XUM_PROVIDER_BY_CATALOG_PROVIDER.get(catalogProvider) ?? catalogProvider;
    if (!isValidProvider(provider) || CUSTOM_MODEL_HIDDEN_PROVIDERS.has(provider)) {
      continue;
    }
    const id = `${provider}:${providerModelId}`;
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    const builtIn = BUILT_IN_BY_ID.get(id);
    const maxInputTokens = getModelStats(id)?.max_input_tokens ?? 0;
    const names = [id, providerModelId, ...(builtIn?.aliases ?? [])].map((name) =>
      name.toLowerCase()
    );
    const displayNames = [
      PROVIDER_DISPLAY_NAMES[provider],
      formatModelDisplayName(providerModelId),
    ];
    index.push({
      entry: {
        id,
        provider,
        providerModelId,
        contextWindowTokens: maxInputTokens > 0 ? maxInputTokens : null,
        builtIn: builtIn !== undefined,
      },
      fields: [...names, provider, ...displayNames.map((name) => name.toLowerCase())],
      names,
    });
  }
  cachedIndex = index;
  return index;
}

// 0 = exact id/model/alias match, 1 = prefix, 2 = substring. A multi-token
// query ranks by its weakest token so every token must be strong to rank high.
function rankEntry(indexed: IndexedCatalogEntry, tokens: string[]): number {
  let rank = 0;
  for (const token of tokens) {
    const tokenRank = indexed.names.includes(token)
      ? 0
      : indexed.fields.some((field) => field.startsWith(token))
        ? 1
        : 2;
    rank = Math.max(rank, tokenRank);
  }
  return rank;
}

/**
 * Filters the catalogue by query/provider/`isAllowed` (the effective policy),
 * ranks it, then pages it. `total` counts every match before paging.
 */
export function searchModelCatalog(
  input: ModelCatalogSearchInput,
  isAllowed: (provider: string, providerModelId: string) => boolean = () => true
): ModelCatalogSearchResult {
  const tokens = tokenizeModelQuery(input.query);
  const matches: Array<{ entry: ModelCatalogEntry; rank: number }> = [];
  for (const indexed of getCatalogIndex()) {
    const { entry } = indexed;
    if (input.provider != null && entry.provider !== input.provider) continue;
    if (!matchesModelQueryTokens(tokens, indexed.fields)) continue;
    if (!isAllowed(entry.provider, entry.providerModelId)) continue;
    matches.push({ entry, rank: rankEntry(indexed, tokens) });
  }
  matches.sort(
    (a, b) =>
      a.rank - b.rank ||
      Number(b.entry.builtIn) - Number(a.entry.builtIn) ||
      (a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0)
  );

  const offset = input.offset ?? 0;
  const end = input.limit == null ? matches.length : offset + input.limit;
  const models = matches.slice(offset, end).map((match) => match.entry);
  return {
    models,
    total: matches.length,
    nextOffset: end < matches.length ? end : null,
  };
}
