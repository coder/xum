import { useCallback, useEffect, useMemo, useId, useRef, useState } from "react";
import { ArrowRight, ChevronDown, Info, Loader2, Plus, Search, ShieldCheck } from "lucide-react";
import { useProviderOptions } from "@/browser/hooks/useProviderOptions";
import { Button } from "@/browser/components/Button/Button";
import { ModelFallbacksEditor } from "./ModelFallbacksEditor";
import { ProviderIcon } from "@/browser/components/ProviderIcon/ProviderIcon";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/browser/components/SelectPrimitive/SelectPrimitive";
import { useAPI } from "@/browser/contexts/API";
import { useSettings } from "@/browser/contexts/SettingsContext";
import { useModelsFromSettings } from "@/browser/hooks/useModelsFromSettings";
import { useRouting } from "@/browser/hooks/useRouting";
import { useMinThinkingLevels } from "@/browser/hooks/useMinThinkingLevels";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { useProvidersConfig } from "@/browser/hooks/useProvidersConfig";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { listModelCatalogIds } from "@/common/utils/tokens/modelCatalog";
import { usePolicy } from "@/browser/contexts/PolicyContext";
import { getExplicitGatewayPrefix, supports1MContext } from "@/common/utils/ai/models";
import { getAllowedProvidersForUi } from "@/browser/utils/policyUi";
import { LAST_CUSTOM_MODEL_PROVIDER_KEY } from "@/common/constants/storage";
import type {
  EffectivePolicy,
  ModelCatalogEntry,
  ModelCatalogSearchResult,
  ProviderModelDiscoveryResult,
  ProviderModelEntry,
  ProvidersConfigMap,
} from "@/common/orpc/types";
import {
  getProviderModelEntryContextWindowTokens,
  getProviderModelEntryId,
  getProviderModelEntryMappedTo,
} from "@/common/utils/providers/modelEntries";
import { formatProviderDisplayName } from "@/common/utils/providers/customProviders";
import {
  CUSTOM_MODELS_PAGE_SIZE,
  MAX_RENDERED_MODELS,
  MODEL_CATALOG_SUGGESTION_PAGE_SIZE,
} from "@/common/constants/ui";
import { CUSTOM_MODEL_HIDDEN_PROVIDERS } from "@/common/constants/providers";
import {
  matchesModelQueryTokens,
  tokenizeModelQuery,
} from "@/common/utils/tokens/modelCatalogSearch";
import { stopKeyboardPropagation } from "@/browser/utils/events";
import { getModelIdLengthError } from "@/browser/utils/boundedPersistedValue";
import { ModelRow } from "./ModelRow";

// Shared header cell styles
const headerCellBase = "py-1.5 pr-2 text-xs font-medium text-muted";

// Table header component to avoid duplication
function ModelsTableHeader() {
  return (
    <thead>
      <tr className="border-border-medium bg-background-secondary/50 border-b">
        <th className={`${headerCellBase} pl-2 text-left md:pl-3`}>Model</th>
        <th className={`${headerCellBase} w-16 text-right md:w-20`}>Context</th>
        <th className={`${headerCellBase} w-32 text-left md:w-40`}>Route</th>
        <th className={`${headerCellBase} w-28 text-left md:w-32`}>Min Thinking</th>
        <th className={`${headerCellBase} w-28 text-right md:w-32 md:pr-3`}>Actions</th>
      </tr>
    </thead>
  );
}

type SuggestionOption =
  | { key: string; kind: "discovered"; modelId: string }
  | { key: string; kind: "catalog"; model: ModelCatalogEntry }
  | { key: string; kind: "catalog-more" };

interface EditingState {
  provider: string;
  originalModelId: string;
  newModelId: string;
  contextWindowTokens: string;
  mappedToModel: string;
  focus?: "model" | "context";
}

function parseContextWindowTokensInput(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}

function buildProviderModelEntry(
  modelId: string,
  contextWindowTokens: number | null,
  mappedToModel: string | null
): ProviderModelEntry {
  if (contextWindowTokens === null && mappedToModel === null) {
    return modelId;
  }

  const entry: Exclude<ProviderModelEntry, string> = { id: modelId };
  if (contextWindowTokens !== null) {
    entry.contextWindowTokens = contextWindowTokens;
  }
  if (mappedToModel !== null) {
    entry.mappedToModel = mappedToModel;
  }

  return entry;
}

export function shouldAllowRouteOverrideInSettings(modelId: string): boolean {
  // Explicit gateway rows already pin their route in the model ID. Wiring the
  // route picker here would mutate the canonical sibling row's override while
  // leaving the explicit row itself pinned to its gateway.
  return getExplicitGatewayPrefix(modelId) === undefined;
}

export function ModelsSection() {
  const policyState = usePolicy();
  const effectivePolicy =
    policyState.status.state === "enforced" ? (policyState.policy ?? null) : null;

  const { api } = useAPI();
  const { open: openSettings, close: closeSettings } = useSettings();
  const { config, loading, updateModelsOptimistically } = useProvidersConfig();
  const [lastProvider, setLastProvider] = usePersistedState(LAST_CUSTOM_MODEL_PROVIDER_KEY, "");
  const [newModelId, setNewModelId] = useState("");
  // Each opening owns its reply: closing and reopening must not resurrect an old catalog.
  const [suggestionsSession, setSuggestionsSession] = useState<object | null>(null);
  const [discovery, setDiscovery] = useState<{
    session: object;
    api: object;
    provider: string;
    config: ProvidersConfigMap;
    policy: EffectivePolicy | null;
    result: ProviderModelDiscoveryResult;
  } | null>(null);
  // Catalogue matches across providers, fenced by session, client, and policy.
  const [catalog, setCatalog] = useState<{
    session: object;
    api: object;
    query: string;
    policy: EffectivePolicy | null;
    result: ModelCatalogSearchResult;
  } | null>(null);
  const [highlightedModel, setHighlightedModel] = useState<{
    key: string;
    api: object | null;
    provider: string;
    config: ProvidersConfigMap | null;
    policy: EffectivePolicy | null;
  } | null>(null);
  const modelInputRef = useRef<HTMLInputElement>(null);
  const suggestionsId = useId();
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modelFilter, setModelFilter] = useState("");
  // Page belongs to the filter it was chosen under, so a new filter shows page 1.
  const [customPage, setCustomPage] = useState({ filter: "", index: 0 });

  const allowedProviders = useMemo(
    () =>
      getAllowedProvidersForUi(effectivePolicy, config).filter(
        (provider) => !CUSTOM_MODEL_HIDDEN_PROVIDERS.has(provider)
      ),
    [effectivePolicy, config]
  );

  useEffect(() => {
    if (config === null || !lastProvider || allowedProviders.includes(lastProvider)) {
      return;
    }

    // Sync persisted lastProvider to backend provider config after providers finish loading.
    setLastProvider(allowedProviders[0] ?? "");
  }, [config, allowedProviders, lastProvider, setLastProvider]);

  const {
    defaultModel,
    setDefaultModel,
    hiddenModels,
    hideModel,
    unhideModel,
    isAllowedByPolicyOnActiveRoute,
  } = useModelsFromSettings();
  const routing = useRouting();
  const minThinking = useMinThinkingLevels();
  const { has1MContext, toggle1MContext } = useProviderOptions();

  // "Treat as" targets must carry the metadata (pricing, context window) that
  // mapping inherits: any model in the token catalog qualifies, not just the
  // curated KNOWN_MODELS list (#3727).
  const treatAsModelIds = listModelCatalogIds();

  // Check if a model already exists (for duplicate prevention)
  const modelExists = useCallback(
    (provider: string, modelId: string, excludeOriginal?: string): boolean => {
      if (!config) return false;
      const currentModels = config[provider]?.models ?? [];
      return currentModels.some((entry) => {
        const currentModelId = getProviderModelEntryId(entry);
        return currentModelId === modelId && currentModelId !== excludeOriginal;
      });
    },
    [config]
  );

  // Shared by typed IDs and discovered suggestions.
  // Returns whether the model was added so the text path only clears its
  // input on success (a rejected duplicate keeps the typed ID visible).
  const addModel = (provider: string, modelId: string): boolean => {
    if (!config) return false;

    // mux-gateway is a routing layer, not a provider users should add models under.
    if (CUSTOM_MODEL_HIDDEN_PROVIDERS.has(provider)) {
      setError("Xum Gateway models can't be added directly. Enable Gateway per-model instead.");
      return false;
    }

    // Check for duplicates
    if (modelExists(provider, modelId)) {
      setError(`Model "${modelId}" already exists for this provider`);
      return false;
    }

    const lengthError = getModelIdLengthError(provider, modelId);
    if (lengthError) {
      setError(lengthError);
      return false;
    }

    if (!api) return false;
    setError(null);

    // Optimistic update - returns new models array for API call
    const updatedModels = updateModelsOptimistically(provider, (models) => [...models, modelId]);

    // Save in background
    void api.providers.setModels({ provider, models: updatedModels });
    return true;
  };

  const resetAddField = () => {
    setNewModelId("");
    setSuggestionsSession(null);
    setHighlightedModel(null);
  };

  const handleAddModel = () => {
    const trimmedModelId = newModelId.trim();
    if (!lastProvider || !trimmedModelId) return;
    // IDs stay free-form (providers reject unknown ones), but the field doubles
    // as a search box, so whitespace means a query was submitted as an ID.
    if (/\s/.test(trimmedModelId)) {
      setError("Model IDs can't contain spaces");
      return;
    }

    if (addModel(lastProvider, trimmedModelId)) {
      resetAddField();
    }
  };

  // Catalogue rows name their own provider, which may differ from the selected one.
  const handleAddCatalogModel = (model: ModelCatalogEntry) => {
    if (addModel(model.provider, model.providerModelId)) {
      setLastProvider(model.provider);
      resetAddField();
    }
  };

  const addError = editing ? null : error;

  const catalogQuery = newModelId.trim();
  const catalogQueryActive = catalogQuery.length > 0;
  useEffect(() => {
    if (!suggestionsSession || !catalogQuery || !api) {
      return;
    }
    const controller = new AbortController();
    api.providers
      .searchModelCatalog(
        { query: catalogQuery, limit: MODEL_CATALOG_SUGGESTION_PAGE_SIZE },
        { signal: controller.signal }
      )
      .then(
        (result) => {
          if (!controller.signal.aborted) {
            setCatalog({
              session: suggestionsSession,
              api,
              query: catalogQuery,
              policy: effectivePolicy,
              result,
            });
          }
        },
        // Catalogue suggestions are optional; manual entry and discovery still
        // work. A failed search still retires the previous query's matches.
        () => {
          if (!controller.signal.aborted) {
            setCatalog(null);
          }
        }
      );
    return () => controller.abort();
  }, [api, suggestionsSession, catalogQuery, effectivePolicy]);

  // Previous-query matches stay visible until the new search settles to avoid
  // flicker while typing; a new session, client, or policy revokes them.
  const activeCatalog =
    catalogQueryActive &&
    catalog?.session === suggestionsSession &&
    catalog?.api === api &&
    catalog?.policy === effectivePolicy
      ? catalog
      : null;

  useEffect(() => {
    // Coder already publishes its routing catalog; discovery must not invoke its writers.
    if (!suggestionsSession || !lastProvider || lastProvider === "coder" || !api || !config) {
      return;
    }
    const controller = new AbortController();
    const publish = (result: ProviderModelDiscoveryResult) => {
      if (!controller.signal.aborted) {
        setDiscovery({
          session: suggestionsSession,
          api,
          provider: lastProvider,
          config,
          policy: effectivePolicy,
          result,
        });
      }
    };
    api.providers
      .discoverModels({ provider: lastProvider }, { signal: controller.signal })
      .then(publish, () => publish({ status: "error", reason: "request-failed" }));
    return () => controller.abort();
  }, [api, suggestionsSession, lastProvider, config, effectivePolicy]);

  // Key rotation can leave every sanitized field equal. Fence rendered suggestions as
  // well as replies by the config object itself, before effect cleanup gets to run.
  // Policy events are independent of config refreshes and also revoke completed catalogs.
  // A disconnect or reconnect replaces the API client, which revokes them too.
  const discoveryResult =
    discovery?.session === suggestionsSession &&
    discovery?.api === api &&
    discovery?.provider === lastProvider &&
    discovery?.config === config &&
    discovery?.policy === effectivePolicy
      ? discovery.result
      : null;
  const discoveredModels =
    lastProvider === "coder"
      ? (config?.coder?.discoveredModels ?? [])
      : discoveryResult?.status === "ok"
        ? discoveryResult.modelIds
        : [];
  // One editable field handles both manual IDs and policy-filtered discovery.
  // Suggestions never replace a typed ID unless the user explicitly chooses one.
  const discoveredUnconfigured = discoveredModels.filter(
    (modelId) => !modelExists(lastProvider, modelId)
  );
  const matchingModels = discoveredUnconfigured.filter((modelId) =>
    modelId.toLowerCase().includes(newModelId.trim().toLowerCase())
  );
  const suggestions = matchingModels.slice(0, MAX_RENDERED_MODELS);
  const discoveredOptions: SuggestionOption[] = suggestions.map((modelId) => ({
    key: `discovered:${modelId}`,
    kind: "discovered",
    modelId,
  }));
  // Built-in and already-added models are selectable elsewhere, so they are not
  // offered; neither are rows already listed as discovered for this provider.
  const isOfferableCatalogModel = (model: ModelCatalogEntry) =>
    !model.builtIn &&
    !modelExists(model.provider, model.providerModelId) &&
    !(model.provider === lastProvider && suggestions.includes(model.providerModelId));
  const catalogOptions: SuggestionOption[] = (activeCatalog?.result.models ?? [])
    .filter(isOfferableCatalogModel)
    .map((model) => ({ key: `catalog:${model.id}`, kind: "catalog", model }));
  const catalogRemaining =
    activeCatalog?.result.nextOffset != null
      ? activeCatalog.result.total - activeCatalog.result.models.length
      : 0;
  if (catalogRemaining > 0) {
    catalogOptions.push({ key: "catalog-more", kind: "catalog-more" });
  }
  const options = [...discoveredOptions, ...catalogOptions];
  // One status line at most. Visible suggestions (discovered or catalogue)
  // suppress everything but loading, so the line never contradicts the list.
  const catalogueHasNoMatches = activeCatalog?.query === catalogQuery && options.length === 0;
  const noMatchesMessage = lastProvider
    ? "No matching catalogue models to add."
    : "No matching catalogue models. Choose a provider to add this ID manually.";
  const statusMessage = !suggestionsSession
    ? null
    : lastProvider && lastProvider !== "coder" && api && config
      ? !discoveryResult
        ? "Loading models… You can still enter a model ID."
        : options.length > 0
          ? null
          : discoveryResult.status !== "ok"
            ? "Suggestions unavailable. Enter a model ID manually."
            : discoveryResult.modelIds.length === 0
              ? "No models found. Enter a model ID manually."
              : catalogueHasNoMatches
                ? noMatchesMessage
                : null
      : catalogueHasNoMatches
        ? noMatchesMessage
        : null;
  const showSuggestions = suggestionsSession !== null && options.length > 0;
  const highlightedIndex =
    showSuggestions &&
    highlightedModel?.api === api &&
    highlightedModel?.config === config &&
    highlightedModel?.provider === lastProvider &&
    highlightedModel?.policy === effectivePolicy
      ? options.findIndex((option) => option.key === highlightedModel.key)
      : -1;

  const loadMoreCatalog = () => {
    const current = activeCatalog;
    const offset = current?.result.nextOffset ?? null;
    if (!current || offset === null || !api) return;
    // Keep the highlight on "Show more" (also after a click) so Enter pages again rather
    // than adding a model the user never picked or the typed query.
    setHighlightedModel({
      key: "catalog-more",
      api,
      provider: lastProvider,
      config,
      policy: effectivePolicy,
    });
    api.providers
      .searchModelCatalog({
        query: current.query,
        offset,
        limit: MODEL_CATALOG_SUGGESTION_PAGE_SIZE,
      })
      .then(
        (page) => {
          // Append only onto the exact result this page continues.
          setCatalog((prev) =>
            prev === current
              ? {
                  ...current,
                  result: { ...page, models: [...current.result.models, ...page.models] },
                }
              : prev
          );
        },
        () => undefined
      );
  };

  const selectOption = (option: SuggestionOption) => {
    if (option.kind === "discovered") {
      if (addModel(lastProvider, option.modelId)) resetAddField();
    } else if (option.kind === "catalog") handleAddCatalogModel(option.model);
    else loadMoreCatalog();
  };

  const renderOption = (option: SuggestionOption, index: number) => {
    const highlighted = index === highlightedIndex;
    const baseClassName = `hover:bg-hover w-full rounded-sm px-2 py-1 text-left text-xs ${highlighted ? "bg-hover" : ""}`;
    return (
      <button
        key={option.key}
        id={`${suggestionsId}-${index}`}
        type="button"
        role="option"
        aria-selected={highlighted}
        tabIndex={-1}
        ref={(element) => {
          if (highlighted) element?.scrollIntoView({ block: "nearest" });
        }}
        // Keep mouse selection in the input; do not cancel touch scrolling.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          modelInputRef.current?.focus();
          selectOption(option);
        }}
        className={
          option.kind === "catalog"
            ? `${baseClassName} grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2`
            : option.kind === "discovered"
              ? `${baseClassName} block font-mono wrap-anywhere`
              : `${baseClassName} text-muted block`
        }
      >
        {option.kind === "discovered" ? (
          option.modelId
        ) : option.kind === "catalog" ? (
          <>
            <span className="text-muted inline-flex items-center gap-1 whitespace-nowrap">
              {/* Some icon SVGs carry a <title>; the visible name labels the row, so keep the
                  title out of the accessible name and off hover (native tooltip). */}
              <span aria-hidden className="pointer-events-none inline-flex">
                <ProviderIcon provider={option.model.provider} />
              </span>
              {formatProviderDisplayName(option.model.provider, config?.[option.model.provider])}
            </span>
            <span className="font-mono wrap-anywhere">{option.model.providerModelId}</span>
          </>
        ) : (
          <>
            Show more (<span className="counter-nums">{catalogRemaining}</span>)
          </>
        )}
      </button>
    );
  };

  const handleRemoveModel = useCallback(
    (provider: string, modelId: string) => {
      if (!config || !api) return;

      // Optimistic update - returns new models array for API call
      const updatedModels = updateModelsOptimistically(provider, (models) =>
        models.filter((entry) => getProviderModelEntryId(entry) !== modelId)
      );

      // Save in background
      void api.providers.setModels({ provider, models: updatedModels });
    },
    [api, config, updateModelsOptimistically]
  );

  const handleStartEdit = useCallback(
    (
      provider: string,
      modelId: string,
      contextWindowTokens: number | null,
      mappedToModel: string | null
    ) => {
      setEditing({
        provider,
        originalModelId: modelId,
        newModelId: modelId,
        contextWindowTokens: contextWindowTokens === null ? "" : String(contextWindowTokens),
        mappedToModel: mappedToModel ?? "",
        focus: "model",
      });
      setError(null);
    },
    []
  );

  const handleStartContextEdit = useCallback(
    (
      provider: string,
      modelId: string,
      contextWindowTokens: number | null,
      mappedToModel: string | null
    ) => {
      setEditing({
        provider,
        originalModelId: modelId,
        newModelId: modelId,
        contextWindowTokens: contextWindowTokens === null ? "" : String(contextWindowTokens),
        mappedToModel: mappedToModel ?? "",
        focus: "context",
      });
      setError(null);
    },
    []
  );

  const handleCancelEdit = useCallback(() => {
    setEditing(null);
    setError(null);
  }, []);

  const handleSaveEdit = useCallback(() => {
    if (!config || !editing || !api) return;

    const trimmedModelId = editing.newModelId.trim();
    if (!trimmedModelId) {
      setError("Model ID cannot be empty");
      return;
    }

    const contextWindowTokensInput = editing.contextWindowTokens.trim();
    const parsedContextWindowTokens = parseContextWindowTokensInput(contextWindowTokensInput);
    if (contextWindowTokensInput.length > 0 && parsedContextWindowTokens === null) {
      setError("Context window must be a positive integer");
      return;
    }

    // Only validate duplicates if the model ID actually changed
    if (trimmedModelId !== editing.originalModelId) {
      if (modelExists(editing.provider, trimmedModelId)) {
        setError(`Model "${trimmedModelId}" already exists for this provider`);
        return;
      }
      const lengthError = getModelIdLengthError(editing.provider, trimmedModelId);
      if (lengthError) {
        setError(lengthError);
        return;
      }
    }

    setError(null);

    const mappedTo = editing.mappedToModel.trim() || null;
    const replacementEntry = buildProviderModelEntry(
      trimmedModelId,
      parsedContextWindowTokens,
      mappedTo
    );

    // Optimistic update - returns new models array for API call
    const updatedModels = updateModelsOptimistically(editing.provider, (models) => {
      const nextModels: ProviderModelEntry[] = [];
      let replaced = false;

      for (const modelEntry of models) {
        if (!replaced && getProviderModelEntryId(modelEntry) === editing.originalModelId) {
          nextModels.push(replacementEntry);
          replaced = true;
          continue;
        }

        nextModels.push(modelEntry);
      }

      if (!replaced) {
        nextModels.push(replacementEntry);
      }

      return nextModels;
    });
    setEditing(null);

    // Save in background
    void api.providers.setModels({ provider: editing.provider, models: updatedModels });
  }, [api, editing, config, modelExists, updateModelsOptimistically]);

  // Show loading state while config is being fetched
  if (loading || !config) {
    return (
      <div className="flex items-center justify-center gap-2 py-12">
        <Loader2 className="text-muted h-5 w-5 animate-spin" />
        <span className="text-muted text-sm">Loading settings...</span>
      </div>
    );
  }

  // Get all custom models across providers (excluding hidden providers like mux-gateway)
  const getCustomModels = (): Array<{
    provider: string;
    modelId: string;
    fullId: string;
    contextWindowTokens: number | null;
    mappedToModel: string | null;
  }> => {
    const models: Array<{
      provider: string;
      modelId: string;
      fullId: string;
      contextWindowTokens: number | null;
      mappedToModel: string | null;
    }> = [];

    for (const [provider, providerConfig] of Object.entries(config)) {
      // Skip hidden providers (mux-gateway models are routed, not managed as a standalone list)
      if (CUSTOM_MODEL_HIDDEN_PROVIDERS.has(provider)) continue;
      if (!providerConfig.models) continue;

      for (const modelEntry of providerConfig.models) {
        const modelId = getProviderModelEntryId(modelEntry);
        models.push({
          provider,
          modelId,
          fullId: `${provider}:${modelId}`,
          contextWindowTokens: getProviderModelEntryContextWindowTokens(modelEntry),
          mappedToModel: getProviderModelEntryMappedTo(modelEntry),
        });
      }
    }

    return models;
  };

  // Get built-in models from KNOWN_MODELS.
  // Filter by policy so the settings table doesn't list models users can't ever select.
  // The policy applies to the active route's identity (like the backend), so a
  // gateway-only policy keeps rows whose route is that gateway.
  const builtInModels = Object.values(KNOWN_MODELS)
    .map((model) => ({
      provider: model.provider,
      modelId: model.providerModelId,
      fullId: model.id,
      aliases: model.aliases,
    }))
    .filter((model) => isAllowedByPolicyOnActiveRoute(model.fullId));

  const customModels = getCustomModels();

  const filterTokens = tokenizeModelQuery(modelFilter);
  const matchesModelFilter = (model: {
    provider: string;
    modelId: string;
    fullId: string;
    aliases?: string[];
  }) =>
    matchesModelQueryTokens(
      filterTokens,
      [
        model.fullId,
        model.provider,
        formatProviderDisplayName(model.provider, config[model.provider]),
        model.modelId,
        ...(model.aliases ?? []),
      ].map((field) => field.toLowerCase())
    );
  const filteredCustomModels = customModels.filter(matchesModelFilter);
  const filteredBuiltInModels = builtInModels.filter(matchesModelFilter);
  const customPageCount = Math.max(
    1,
    Math.ceil(filteredCustomModels.length / CUSTOM_MODELS_PAGE_SIZE)
  );
  // Clamp too: removing rows can leave the stored page past the end.
  const customPageIndex = Math.min(
    customPage.filter === modelFilter ? customPage.index : 0,
    customPageCount - 1
  );
  const customPageStart = customPageIndex * CUSTOM_MODELS_PAGE_SIZE;
  const pagedCustomModels = filteredCustomModels.slice(
    customPageStart,
    customPageStart + CUSTOM_MODELS_PAGE_SIZE
  );

  return (
    <div className="space-y-4">
      {policyState.status.state === "enforced" && (
        <div className="border-border-medium bg-background-secondary/50 text-muted flex items-center gap-2 rounded-md border px-3 py-2 text-xs">
          <ShieldCheck className="h-4 w-4" aria-hidden />
          <span>Your settings are controlled by a policy.</span>
        </div>
      )}

      <div className="relative">
        <Search
          aria-hidden
          className="text-muted pointer-events-none absolute top-2 left-2 h-3.5 w-3.5"
        />
        <input
          type="text"
          aria-label="Filter models"
          placeholder="Filter models"
          autoComplete="off"
          value={modelFilter}
          // Filtering or paging would unmount the row being edited and strand its Save/Cancel.
          disabled={editing !== null}
          onChange={(e) => setModelFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            e.preventDefault();
            stopKeyboardPropagation(e);
            // The dialog ignores Escape from inputs, so an empty filter closes Settings itself.
            if (modelFilter) setModelFilter("");
            else closeSettings();
          }}
          className="bg-background border-border-medium focus:border-accent h-8 w-full rounded border py-1 pr-2 pl-7 text-xs focus:outline-none"
        />
      </div>

      {/* Custom Models */}
      <div className="space-y-3">
        <div className="text-muted text-xs font-medium tracking-wide uppercase">Custom Models</div>

        {/* Add new model form - styled to match table */}
        <div className="border-border-medium rounded-md border">
          <div className="border-border-medium bg-background-secondary/50 relative flex flex-wrap items-center gap-1.5 border-b px-2 py-1.5 md:px-3">
            <Select
              value={lastProvider}
              onValueChange={(provider) => {
                setLastProvider(provider);
                setSuggestionsSession(null);
                setHighlightedModel(null);
              }}
            >
              <SelectTrigger
                aria-label="Provider"
                className="bg-background border-border-medium focus:border-accent h-7 w-auto shrink-0 rounded border px-2 text-xs"
              >
                <SelectValue placeholder="Provider" />
              </SelectTrigger>
              <SelectContent>
                {allowedProviders.map((provider) => (
                  <SelectItem key={provider} value={provider}>
                    <span className="inline-flex items-center gap-1 whitespace-nowrap">
                      <ProviderIcon provider={provider} />
                      <span>{formatProviderDisplayName(provider, config?.[provider])}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {/* Below md the suggestions span the whole add row, not just the narrow input. */}
            <div
              className="min-w-[8rem] flex-1 md:relative"
              onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget)) {
                  setSuggestionsSession(null);
                  setHighlightedModel(null);
                }
              }}
            >
              <div className="relative">
                <input
                  ref={modelInputRef}
                  type="text"
                  role="combobox"
                  aria-label="Model ID"
                  aria-autocomplete="list"
                  aria-describedby={
                    [
                      statusMessage && `${suggestionsId}-status`,
                      addError && `${suggestionsId}-error`,
                    ]
                      .filter(Boolean)
                      .join(" ") || undefined
                  }
                  aria-invalid={addError ? true : undefined}
                  aria-expanded={showSuggestions}
                  aria-controls={showSuggestions ? suggestionsId : undefined}
                  aria-activedescendant={
                    highlightedIndex >= 0 ? `${suggestionsId}-${highlightedIndex}` : undefined
                  }
                  autoComplete="off"
                  value={newModelId}
                  onChange={(e) => {
                    setNewModelId(e.target.value);
                    setHighlightedModel(null);
                    if (addError) setError(null);
                    setSuggestionsSession((session) => session ?? {});
                  }}
                  onFocus={() => setSuggestionsSession((session) => session ?? {})}
                  onClick={() => setSuggestionsSession((session) => session ?? {})}
                  placeholder="model-id"
                  className="bg-background border-border-medium focus:border-accent h-7 w-full rounded border py-1 pr-6 pl-2 font-mono text-xs focus:outline-none"
                  onKeyDown={(e) => {
                    if (e.nativeEvent.isComposing) return;
                    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                      e.preventDefault();
                      setSuggestionsSession((session) => session ?? {});
                      const next =
                        e.key === "ArrowDown"
                          ? Math.min(highlightedIndex + 1, options.length - 1)
                          : highlightedIndex < 0
                            ? options.length - 1
                            : Math.max(highlightedIndex - 1, 0);
                      const option = options[next];
                      setHighlightedModel(
                        option
                          ? {
                              key: option.key,
                              api,
                              provider: lastProvider,
                              config,
                              policy: effectivePolicy,
                            }
                          : null
                      );
                    } else if (e.key === "Enter") {
                      e.preventDefault();
                      const option = highlightedIndex >= 0 ? options[highlightedIndex] : undefined;
                      if (option) selectOption(option);
                      // Once the last page removes "Show more", Enter must not add the typed query.
                      else if (highlightedModel?.key !== "catalog-more") handleAddModel();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      stopKeyboardPropagation(e);
                      // Matches the filter: close the list, then clear, then close Settings.
                      if (showSuggestions || statusMessage) {
                        setSuggestionsSession(null);
                        setHighlightedModel(null);
                      } else if (newModelId) resetAddField();
                      else closeSettings();
                    }
                  }}
                />
                {discoveredUnconfigured.length > 0 && (
                  <ChevronDown
                    aria-hidden
                    className="text-muted pointer-events-none absolute top-2 right-2 h-3 w-3"
                  />
                )}
              </div>
              {showSuggestions && (
                <div
                  id={suggestionsId}
                  role="listbox"
                  aria-label="Model suggestions"
                  className="bg-background border-border-medium absolute inset-x-2 top-full z-50 mt-1 max-h-60 overflow-y-auto rounded border p-1 shadow-md md:inset-x-0"
                >
                  {discoveredOptions.length > 0 && (
                    <div role="group" aria-label="Discovered models">
                      {discoveredOptions.map((option, index) => renderOption(option, index))}
                      {matchingModels.length > suggestions.length && (
                        <div className="text-muted px-2 py-1 text-xs">
                          Keep typing to narrow the list
                        </div>
                      )}
                    </div>
                  )}
                  {catalogOptions.length > 0 && (
                    <div role="group" aria-labelledby={`${suggestionsId}-catalog`}>
                      <div
                        id={`${suggestionsId}-catalog`}
                        className="text-muted px-2 pt-1.5 pb-0.5 text-[11px] font-medium tracking-wide uppercase"
                      >
                        From catalogue
                      </div>
                      {catalogOptions.map((option, index) =>
                        renderOption(option, discoveredOptions.length + index)
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
            <Button
              type="button"
              size="sm"
              onClick={() => handleAddModel()}
              disabled={!lastProvider || !newModelId.trim()}
              className="h-7 shrink-0 gap-1 px-2 text-xs"
            >
              <Plus className="h-3.5 w-3.5" />
              Add
            </Button>
          </div>
          {statusMessage && (
            <div
              id={`${suggestionsId}-status`}
              role="status"
              className="text-muted px-2 py-1.5 text-xs md:px-3"
            >
              {statusMessage}
            </div>
          )}
          {addError && (
            <div id={`${suggestionsId}-error`} className="text-error px-2 py-1.5 text-xs md:px-3">
              {addError}
            </div>
          )}
        </div>

        {/* Table of custom models */}
        {customModels.length > 0 && filteredCustomModels.length === 0 && (
          <div className="border-border-medium text-muted rounded-md border px-3 py-2 text-xs">
            No custom models match the filter.
          </div>
        )}
        {pagedCustomModels.length > 0 && (
          <div className="border-border-medium overflow-x-auto rounded-md border">
            <table className="w-full">
              <ModelsTableHeader />
              <tbody>
                {pagedCustomModels.map((model) => {
                  const isModelEditing =
                    editing?.provider === model.provider &&
                    editing?.originalModelId === model.modelId;
                  const allowRouteOverride = shouldAllowRouteOverrideInSettings(model.fullId);
                  return (
                    <ModelRow
                      key={model.fullId}
                      provider={model.provider}
                      modelId={model.modelId}
                      fullId={model.fullId}
                      mappedToModel={model.mappedToModel}
                      isCustom={true}
                      isDefault={defaultModel === model.fullId}
                      isEditing={isModelEditing}
                      editModelValue={isModelEditing ? editing.newModelId : undefined}
                      editContextValue={isModelEditing ? editing.contextWindowTokens : undefined}
                      editMappedToModel={isModelEditing ? editing.mappedToModel : undefined}
                      editAutofocus={isModelEditing ? editing.focus : undefined}
                      customContextWindowTokens={model.contextWindowTokens}
                      allModels={treatAsModelIds}
                      editError={isModelEditing ? error : undefined}
                      saving={false}
                      hasActiveEdit={editing !== null}
                      resolvedRoute={routing.resolveRoute(model.fullId)}
                      autoResolvedRoute={routing.resolveAutoRoute(model.fullId)}
                      availableRoutes={routing.availableRoutes(model.fullId)}
                      is1MContextEnabled={has1MContext(model.fullId)}
                      onSetDefault={() => setDefaultModel(model.fullId)}
                      onStartEdit={() =>
                        handleStartEdit(
                          model.provider,
                          model.modelId,
                          model.contextWindowTokens,
                          model.mappedToModel
                        )
                      }
                      onStartContextEdit={() =>
                        handleStartContextEdit(
                          model.provider,
                          model.modelId,
                          model.contextWindowTokens,
                          model.mappedToModel
                        )
                      }
                      onSaveEdit={handleSaveEdit}
                      onCancelEdit={handleCancelEdit}
                      onEditModelChange={(value) =>
                        setEditing((prev) => (prev ? { ...prev, newModelId: value } : null))
                      }
                      onEditContextChange={(value) =>
                        setEditing((prev) =>
                          prev ? { ...prev, contextWindowTokens: value } : null
                        )
                      }
                      onEditMappedToModelChange={(value) =>
                        setEditing((prev) => (prev ? { ...prev, mappedToModel: value } : null))
                      }
                      onRemove={() => handleRemoveModel(model.provider, model.modelId)}
                      isHiddenFromSelector={hiddenModels.includes(model.fullId)}
                      onToggleVisibility={() =>
                        hiddenModels.includes(model.fullId)
                          ? unhideModel(model.fullId)
                          : hideModel(model.fullId)
                      }
                      onSetRouteOverride={
                        allowRouteOverride
                          ? (route) => routing.setRouteOverride(model.fullId, route)
                          : undefined
                      }
                      minThinkingLevel={minThinking.getMinOverride(model.fullId)}
                      onSetMinThinkingLevel={(level) =>
                        minThinking.setMinThinkingLevel(model.fullId, level)
                      }
                      onToggle1MContext={
                        supports1MContext(model.fullId, config)
                          ? () => toggle1MContext(model.fullId)
                          : undefined
                      }
                      providersConfig={config}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {filteredCustomModels.length > CUSTOM_MODELS_PAGE_SIZE && (
          <div className="flex items-center justify-end gap-2 text-xs">
            <span className="text-muted counter-nums">
              {customPageStart + 1}-{customPageStart + pagedCustomModels.length} of{" "}
              {filteredCustomModels.length}
            </span>
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={customPageIndex === 0 || editing !== null}
              onClick={() => setCustomPage({ filter: modelFilter, index: customPageIndex - 1 })}
            >
              Previous
            </Button>
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={customPageIndex >= customPageCount - 1 || editing !== null}
              onClick={() => setCustomPage({ filter: modelFilter, index: customPageIndex + 1 })}
            >
              Next
            </Button>
          </div>
        )}
      </div>

      {/* Built-in Models */}
      <div className="space-y-3">
        <div className="text-muted text-xs font-medium tracking-wide uppercase">
          Built-in Models
        </div>
        {filterTokens.length > 0 && filteredBuiltInModels.length === 0 ? (
          <div className="border-border-medium text-muted rounded-md border px-3 py-2 text-xs">
            No built-in models match the filter.
          </div>
        ) : (
          <div className="border-border-medium overflow-x-auto rounded-md border">
            <table className="w-full">
              <ModelsTableHeader />
              <tbody>
                {filteredBuiltInModels.map((model) => (
                  <ModelRow
                    key={model.fullId}
                    provider={model.provider}
                    modelId={model.modelId}
                    fullId={model.fullId}
                    aliases={model.aliases}
                    isCustom={false}
                    isDefault={defaultModel === model.fullId}
                    isEditing={false}
                    resolvedRoute={routing.resolveRoute(model.fullId)}
                    autoResolvedRoute={routing.resolveAutoRoute(model.fullId)}
                    availableRoutes={routing.availableRoutes(model.fullId)}
                    is1MContextEnabled={has1MContext(model.fullId)}
                    onSetDefault={() => setDefaultModel(model.fullId)}
                    isHiddenFromSelector={hiddenModels.includes(model.fullId)}
                    onToggleVisibility={() =>
                      hiddenModels.includes(model.fullId)
                        ? unhideModel(model.fullId)
                        : hideModel(model.fullId)
                    }
                    onSetRouteOverride={(route) => routing.setRouteOverride(model.fullId, route)}
                    minThinkingLevel={minThinking.getMinOverride(model.fullId)}
                    onSetMinThinkingLevel={(level) =>
                      minThinking.setMinThinkingLevel(model.fullId, level)
                    }
                    onToggle1MContext={
                      supports1MContext(model.fullId, config)
                        ? () => toggle1MContext(model.fullId)
                        : undefined
                    }
                    providersConfig={config}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <ModelFallbacksEditor />

      <div className="border-border-medium bg-background-secondary/40 text-muted rounded-md border px-3 py-2.5 text-xs">
        <div className="flex items-start gap-2">
          <Info className="text-accent mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <div className="space-y-1">
            <p>
              Agent-specific model defaults and thinking levels (Compact and others) are configured
              in <span className="text-foreground font-medium">Settings → Agents</span>.
            </p>
            <Button
              type="button"
              variant="link"
              size="sm"
              onClick={() => openSettings("tasks")}
              className="text-accent h-auto px-0 py-0 text-xs"
            >
              Open Agents settings
              <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </div>

      {/* Oneshot Tips */}
      <div className="space-y-2">
        <div className="text-muted text-xs font-medium tracking-wide uppercase">
          Quick Shortcuts
        </div>
        <div className="border-border-medium bg-background-secondary/50 rounded-md border px-3 py-2.5 text-xs leading-relaxed">
          <p className="text-foreground mb-1.5 font-medium">
            Use model aliases as slash commands for one-shot overrides:
          </p>
          <div className="text-muted space-y-0.5 font-mono">
            <div>
              <span className="text-accent">/sonnet</span> explain this code
              <span className="text-muted/60 ml-2">— send one message with Sonnet</span>
            </div>
            <div>
              <span className="text-accent">/opus+high</span> deep review
              <span className="text-muted/60 ml-2">— Opus with high thinking</span>
            </div>
            <div>
              <span className="text-accent">/haiku+0</span> quick answer
              <span className="text-muted/60 ml-2">— Haiku with thinking off</span>
            </div>
            <div>
              <span className="text-accent">/+2</span> analyze this
              <span className="text-muted/60 ml-2">— current model, thinking level 2</span>
            </div>
          </div>
          <p className="text-muted mt-1.5">
            Numeric levels are relative to each model (0=lowest allowed, 1=next, etc.). Named
            levels: off, low, med, high, max.
          </p>
        </div>
      </div>
    </div>
  );
}
