import { useEffect, useState } from "react";
import { Button } from "@/browser/components/Button/Button";
import { ModelSelector } from "@/browser/components/ModelSelector/ModelSelector";
import { useAPI } from "@/browser/contexts/API";
import { useModelsFromSettings } from "@/browser/hooks/useModelsFromSettings";
import { useRouting } from "@/browser/hooks/useRouting";
import { getErrorMessage } from "@/common/utils/errors";
import { isEvaluationEligibleModelString } from "@/common/utils/ai/evaluationModels";
import { getExplicitGatewayPrefix } from "@/common/utils/ai/models";

/**
 * Mirrors the backend resolver's two static gates: an eligible origin provider
 * and no explicit gateway prefix (`openrouter:openai/gpt-5` is a deliberate
 * gateway selection the resolver rejects before canonicalizing it).
 */
function canEvaluate(modelString: string): boolean {
  return (
    isEvaluationEligibleModelString(modelString) &&
    getExplicitGatewayPrefix(modelString) === undefined
  );
}

/**
 * Settings card for `evaluationDefaults.model`, the model workflow `evaluate()`
 * steps use when a call names none. Self-contained: it loads its own config
 * slice and persists through the dedicated `updateEvaluationDefaults`
 * endpoint (like GoalsSection), so TasksSection's debounced `saveConfig`
 * payload never carries it.
 *
 * The route hint is client-side selection feedback only (plan §L4 item 2):
 * `resolveRoute` over the loaded providers config says where a chat request
 * for this model would go; evaluation runs on the origin's direct route only,
 * so anything else is flagged here. The backend's call-time gating remains
 * authoritative — this card never verifies the model against the provider.
 */
export function EvaluationModelCard() {
  const { api } = useAPI();
  const { models, hiddenModelsForSelector } = useModelsFromSettings();
  const routing = useRouting();
  const [model, setModel] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

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

  // Only direct-provider models can evaluate; the selector never offers others
  // (including through "Show all models…"), but a value written by an older
  // build or by hand may still be ineligible.
  const eligibleModels = models.filter(canEvaluate);
  const eligibleHiddenModels = hiddenModelsForSelector.filter(canEvaluate);
  const route = model.length > 0 ? routing.resolveRoute(model) : null;
  const hint =
    model.length === 0
      ? null
      : !isEvaluationEligibleModelString(model)
        ? "This provider is not supported for evaluation; choose an OpenAI, Anthropic or Google model."
        : getExplicitGatewayPrefix(model) !== undefined
          ? "Gateway-scoped model strings are unsupported for evaluation; choose the provider's own model with its direct API key."
          : route !== null && route.route !== "direct"
            ? `Would route via ${route.displayName} — unsupported for evaluation. Configure the provider's own API key or pin this model to Direct in Routing.`
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
