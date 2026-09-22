import { useEffect, useState } from "react";
import { Button } from "@/browser/components/Button/Button";
import { ModelSelector } from "@/browser/components/ModelSelector/ModelSelector";
import { useAPI } from "@/browser/contexts/API";
import { useModelsFromSettings } from "@/browser/hooks/useModelsFromSettings";
import { useProvidersConfig } from "@/browser/hooks/useProvidersConfig";
import type { EvaluationModelCheck, ProvidersConfigMap } from "@/common/orpc/types";
import { getErrorMessage } from "@/common/utils/errors";
import { isEvaluationEligibleModelString } from "@/common/utils/ai/evaluationModels";
import { getExplicitGatewayPrefix } from "@/common/utils/ai/models";

/**
 * Settings card for `evaluationDefaults.model`, the model workflow `evaluate()`
 * steps use when a call names none. Self-contained: it loads its own config
 * slice and persists through the dedicated `updateEvaluationDefaults`
 * endpoint (like GoalsSection), so TasksSection's debounced `saveConfig`
 * payload never carries it.
 *
 * Two different gates (plan §L4 item 2):
 * - The offered lists are pre-filtered by static predicates the backend
 *   resolver also applies (eligible origin provider, no explicit gateway prefix,
 *   not shadowed by a custom provider, allowed by the enforced policy).
 * - The hint for the SELECTED model comes from the backend's own resolver
 *   (`config.checkEvaluationModel`, network-free), so auth-mode, route and
 *   credential rules are never re-implemented here. Call-time admission of a
 *   workflow step remains authoritative; this card never verifies the model
 *   against the provider.
 */
export function EvaluationModelCard() {
  const { api } = useAPI();
  const { models, hiddenModelsForSelector, isAllowedByPolicyOnActiveRoute } =
    useModelsFromSettings();
  const { config: providersConfig } = useProvidersConfig();
  const [model, setModel] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Result tagged with the model it describes so a late response for a
  // previous selection can never be shown against a newer one.
  const [check, setCheck] = useState<{ model: string; result: EvaluationModelCheck } | null>(null);

  useEffect(() => {
    if (!api) return;
    void api.config
      .getConfig()
      .then((config) => {
        setModel(config.evaluationDefaults?.model ?? "");
        setLoaded(true);
      })
      .catch((error: unknown) => {
        setSaveError(getErrorMessage(error));
        setLoaded(true);
      });
  }, [api]);

  // Re-check whenever the selection or the providers configuration changes
  // (adding a key or changing routing can flip the verdict).
  useEffect(() => {
    if (!api || model.length === 0) return;
    let cancelled = false;
    void api.config
      .checkEvaluationModel({ model })
      .then((result) => {
        if (!cancelled) setCheck({ model, result });
      })
      .catch(() => {
        // Feedback only: an unreachable check leaves the card without a hint.
      });
    return () => {
      cancelled = true;
    };
  }, [api, model, providersConfig]);

  // Persist first, publish second: the displayed default must never be ahead of
  // the config a workflow started right now would read, and a rejected write
  // keeps showing the value that is actually stored.
  const persist = async (next: string) => {
    const trimmed = next.trim();
    setSaveError(null);
    try {
      await api?.config.updateEvaluationDefaults({ model: trimmed.length > 0 ? trimmed : null });
      setModel(trimmed);
    } catch (error: unknown) {
      setSaveError(getErrorMessage(error));
    }
  };

  const canOffer = (modelString: string) =>
    isEvaluationEligibleModelString(modelString) &&
    getExplicitGatewayPrefix(modelString) === undefined &&
    !isShadowedByCustomProvider(modelString, providersConfig) &&
    isAllowedByPolicyOnActiveRoute(modelString);
  // The same gate for the primary list and "Show all models…": a value written
  // by an older build or by hand may still be ineligible, which the hint covers.
  const eligibleModels = models.filter(canOffer);
  const eligibleHiddenModels = hiddenModelsForSelector.filter(canOffer);
  const hint =
    model.length > 0 && check !== null && check.model === model
      ? describeCheck(check.result)
      : null;

  return (
    <div
      role="group"
      aria-label="Evaluation model"
      className="border-border-medium bg-background-secondary rounded-md border p-3"
    >
      <div className="text-foreground text-sm font-medium">Evaluation model</div>
      <div className="text-muted mt-1 text-xs">
        Used by workflow <code>evaluate()</code> steps that do not name a model. Direct provider API
        keys only (gateway and OAuth routes are rejected). The model must support the
        provider&apos;s structured-output API; unsupported models fail at run time.
      </div>
      <div className="mt-3 flex items-center gap-2">
        <ModelSelector
          value={model}
          emptyLabel="Not set"
          onChange={(value) => void persist(value)}
          models={eligibleModels}
          hiddenModels={eligibleHiddenModels}
          variant="box"
          className="bg-modal-bg"
        />
        {model.length > 0 ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-9 px-2"
            aria-label="Clear evaluation model"
            onClick={() => void persist("")}
          >
            Clear
          </Button>
        ) : null}
      </div>
      {loaded && hint !== null ? (
        <div role="note" className="text-warning mt-2 text-xs">
          {hint}
        </div>
      ) : null}
      {saveError !== null ? (
        <div className="text-danger-light mt-2 text-xs">{saveError}</div>
      ) : null}
    </div>
  );
}

/**
 * Mirrors the backend resolver's shadow check: a custom provider registered
 * under a built-in evaluation provider id (raw prefix, before canonicalization)
 * is a custom endpoint the evaluation path never constructs.
 */
function isShadowedByCustomProvider(
  modelString: string,
  providersConfig: ProvidersConfigMap | null
): boolean {
  const separator = modelString.indexOf(":");
  if (separator <= 0 || providersConfig === null) return false;
  return providersConfig[modelString.slice(0, separator)]?.isCustom === true;
}

/** Fixed template per typed rejection; `null` when the backend would admit the model. */
function describeCheck(result: EvaluationModelCheck): string | null {
  if (result.ok) return null;
  const provider = result.providerName ?? "this provider";
  switch (result.reason) {
    case "unknown-model":
      return "Enter a model as provider:model.";
    case "unsupported-provider":
      return "This provider is not supported for evaluation; choose an OpenAI, Anthropic or Google model.";
    case "unauthorized":
      return `${provider} has no usable API key for evaluation (missing, disabled, or not allowed by policy).`;
    case "unsupported-route":
      switch (result.routeKind) {
        case "gateway":
          return `Would route via ${provider} — unsupported for evaluation. Configure the provider's own API key or pin this model to Direct in Routing.`;
        case "codex-oauth":
          return "OpenAI would use ChatGPT OAuth for this model — unsupported for evaluation. Add an OpenAI API key and prefer it (codexOauthDefaultAuth: apiKey).";
        case "custom":
          return "This provider id is a custom provider in providers.jsonc; evaluation needs the built-in provider.";
        default:
          return "This model's route is unsupported for evaluation; only direct provider API keys work.";
      }
  }
}
