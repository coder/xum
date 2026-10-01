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
import modelsData from "./models.json";
import { PROVIDER_KEY_ALIASES, PROVIDER_KEY_FALLBACKS, getModelStats } from "./modelStats";

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
// (directly or via a stats lookup alias or fallback) are addable as custom models.
// LiteLLM files the Gemini API as `gemini/<model>`; Xum calls it `google` and
// resolves `google:<model>` stats through the bare model key instead.
const XUM_PROVIDER_BY_CATALOG_PROVIDER = new Map<string, string>([
  ...Object.entries({ ...PROVIDER_KEY_ALIASES, ...PROVIDER_KEY_FALLBACKS }).map(
    ([xum, litellm]): [string, string] => [litellm, xum]
  ),
  ["gemini", "google"],
]);

// When a models-extra bare override (e.g. gemini-3.7-flash) shadows the
// `gemini/<model>` entry, the catalogue exposes the model only through the bare
// key's Vertex provider. Such a row is still a Gemini API model when LiteLLM
// also lists it under `gemini/`; Vertex-only models (medlm) stay excluded.
const VERTEX_BARE_CATALOG_PROVIDER = "vertex_ai-language-models";

function resolveXumProvider(catalogProvider: string, providerModelId: string): string {
  if (
    catalogProvider === VERTEX_BARE_CATALOG_PROVIDER &&
    Object.hasOwn(modelsData, `gemini/${providerModelId}`)
  ) {
    return "google";
  }
  return XUM_PROVIDER_BY_CATALOG_PROVIDER.get(catalogProvider) ?? catalogProvider;
}

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
    const provider = resolveXumProvider(catalogProvider, providerModelId);
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

const NATURAL_ORDER = new Intl.Collator("en", { numeric: true });

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
 * Filters the catalogue by query/provider, ranks it, then pages it.
 * `total` counts every match before paging.
 */
export function searchModelCatalog(input: ModelCatalogSearchInput): ModelCatalogSearchResult {
  const tokens = tokenizeModelQuery(input.query);
  const matches: Array<{ entry: ModelCatalogEntry; rank: number }> = [];
  for (const indexed of getCatalogIndex()) {
    const { entry } = indexed;
    if (input.provider != null && entry.provider !== input.provider) continue;
    if (!matchesModelQueryTokens(tokens, indexed.fields)) continue;
    matches.push({ entry, rank: rankEntry(indexed, tokens) });
  }
  // Within a tier, newer-looking versions come first (numeric chunks compare as
  // numbers, so gemini-3.7 precedes gemini-2.5) so older variants sit behind Show more.
  // Group by provider first: a descending compare across providers would let
  // prefixed IDs such as Bedrock's us.anthropic.* outrank the direct provider.
  // Providers with a matching built-in (openai for gpt) lead, so resellers such
  // as GitHub Copilot cannot fill the first page ahead of them.
  const firstPartyProviders = new Set(
    matches.filter((match) => match.entry.builtIn).map((match) => match.entry.provider)
  );
  const isFirstParty = (match: (typeof matches)[number]) =>
    Number(firstPartyProviders.has(match.entry.provider));
  matches.sort(
    (a, b) =>
      a.rank - b.rank ||
      Number(b.entry.builtIn) - Number(a.entry.builtIn) ||
      isFirstParty(b) - isFirstParty(a) ||
      NATURAL_ORDER.compare(a.entry.provider, b.entry.provider) ||
      NATURAL_ORDER.compare(b.entry.providerModelId, a.entry.providerModelId)
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
