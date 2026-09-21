import React, { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Loader2, Plus, RotateCcw, Trash2, X } from "lucide-react";

import { Button } from "@/browser/components/Button/Button";
import { Input } from "@/browser/components/Input/Input";
import { ModelSelector } from "@/browser/components/ModelSelector/ModelSelector";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/browser/components/SelectPrimitive/SelectPrimitive";
import { useAPI } from "@/browser/contexts/API";
import { useAutoModelRouting } from "@/browser/hooks/useAutoModelRouting";
import { useModelsFromSettings } from "@/browser/hooks/useModelsFromSettings";
import { formatPercent } from "@/browser/features/Messages/AutoModelRoutingBadge";
import {
  getDefaultAutoModelRoutingConfig,
  isAutoModelRoutingEvaluationModel,
  splitAutoModelRoutingEvaluationModel,
  type AutoModelRoutingEvaluationStatus,
  type AutoModelRoutingTier,
} from "@/common/types/autoModelRouting";
import { THINKING_LEVELS, isThinkingLevel } from "@/common/types/thinking";
import { getErrorMessage } from "@/common/utils/errors";
import { formatModelStringForDisplay } from "@/common/utils/ai/models";
import {
  AUTO_MODEL_ROUTING_EVALUATION_PROVIDERS,
  AUTO_MODEL_ROUTING_MAX_DESCRIPTION_CHARS,
  AUTO_MODEL_ROUTING_MAX_LABEL_CHARS,
  AUTO_MODEL_ROUTING_MAX_TIERS,
  AUTO_MODEL_ROUTING_MIN_TIERS,
  AUTO_MODEL_ROUTING_RECENT_MESSAGE_LIMIT,
  DEFAULT_AUTO_MODEL_ROUTING_EVALUATION_MODEL,
  TYPESAFE_API_KEY_ENV_VARS,
  TYPESAFE_PROVIDER_KEY,
} from "@/constants/autoModelRouting";

const INHERIT_THINKING = "inherit";
const TIER_TEXT_COMMIT_DEBOUNCE_MS = 500;
const SUPPORTED_EVALUATION_PROVIDERS = AUTO_MODEL_ROUTING_EVALUATION_PROVIDERS.join(", ");
const EVALUATION_MODEL_ERROR = `Enter provider:model using one of ${SUPPORTED_EVALUATION_PROVIDERS}`;

type TierTextField = "label" | "description";
type TierTextDraft = Record<TierTextField, string>;

interface RoutingPreview {
  tierId: string;
  tierLabel: string;
  confidence?: number;
  probabilities?: Record<string, number>;
  evaluationModel: string;
  model?: string;
  thinkingLevel?: string;
}

function nextTierId(tiers: AutoModelRoutingTier[]): string {
  const taken = new Set(tiers.map((tier) => tier.id));
  let index = tiers.length + 1;
  while (taken.has(`tier-${index}`)) index += 1;
  return `tier-${index}`;
}

export function AutoModelRoutingExperimentConfig() {
  const { api } = useAPI();
  const { models, hiddenModelsForSelector } = useModelsFromSettings();
  const { config, setConfig, writeError } = useAutoModelRouting();
  const tiers = config.tiers;

  // Text fields are debounced, not written per keystroke: the IPC boundary rejects
  // empty intermediate values and would revert the field mid-edit. A draft is
  // committed after a pause, on blur, or on Enter; an invalid draft shows its
  // message and reverts on blur.
  const [textDrafts, setTextDrafts] = useState<Record<string, Partial<TierTextDraft>>>({});
  const [textErrors, setTextErrors] = useState<Record<string, Partial<TierTextDraft>>>({});
  const textDraftsRef = useRef(textDrafts);
  textDraftsRef.current = textDrafts;
  // Debounced commits run from a stale render: every delayed write spreads the latest
  // config, so a tier commit cannot restore an evaluation model another window replaced.
  const configRef = useRef(config);
  configRef.current = config;
  const commitTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  // null means "not editing": the field shows the saved evaluation model.
  const [evaluationDraft, setEvaluationDraft] = useState<string | null>(null);
  const evaluationValue = (evaluationDraft ?? config.evaluationModel).trim();
  const evaluationValid = isAutoModelRoutingEvaluationModel(evaluationValue);
  const [evaluationStatus, setEvaluationStatus] = useState<AutoModelRoutingEvaluationStatus | null>(
    null
  );
  const evaluationProvider = evaluationValid
    ? splitAutoModelRoutingEvaluationModel(evaluationValue).provider
    : null;

  const [keyDraft, setKeyDraft] = useState("");
  const [keyError, setKeyError] = useState<string | null>(null);
  const [keyBusy, setKeyBusy] = useState(false);
  // Bumped after a key write so the status effect re-checks the same evaluation model.
  const [statusRefresh, setStatusRefresh] = useState(0);

  const [samplePrompt, setSamplePrompt] = useState("");
  const [preview, setPreview] = useState<RoutingPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [classifying, setClassifying] = useState(false);

  // The status follows the field as typed, not the saved value, so the user sees
  // whether a candidate evaluator is usable before committing it.
  useEffect(() => {
    if (!api || !evaluationValid) return;
    let cancelled = false;
    api.config
      .getAutoModelRoutingEvaluationStatus({ evaluationModel: evaluationValue })
      .then((status) => {
        if (!cancelled) setEvaluationStatus(status);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [api, evaluationValid, evaluationValue, statusRefresh]);

  const replaceTiers = (next: AutoModelRoutingTier[]) =>
    setConfig({ ...configRef.current, tiers: next });
  const updateTier = (id: string, patch: Partial<AutoModelRoutingTier>) =>
    replaceTiers(tiers.map((tier) => (tier.id === id ? { ...tier, ...patch } : tier)));
  const moveTier = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= tiers.length) return;
    const next = [...tiers];
    [next[index], next[target]] = [next[target], next[index]];
    replaceTiers(next);
  };
  const validateText = (id: string, field: TierTextField, value: string): string | null => {
    const trimmed = value.trim();
    if (!trimmed) return field === "label" ? "Label is required" : "Description is required";
    if (
      field === "label" &&
      configRef.current.tiers.some(
        (tier) => tier.id !== id && tier.label.trim().toLowerCase() === trimmed.toLowerCase()
      )
    ) {
      return "Another tier already uses this label";
    }
    return null;
  };
  const setTextError = (id: string, field: TierTextField, error: string | null) =>
    setTextErrors((prev) => ({ ...prev, [id]: { ...prev[id], [field]: error ?? undefined } }));
  const clearTextDraft = (id: string, field: TierTextField) =>
    setTextDrafts((prev) => ({ ...prev, [id]: { ...prev[id], [field]: undefined } }));
  const cancelCommitTimer = (id: string, field: TierTextField) => {
    const key = `${id}:${field}`;
    const timer = commitTimers.current.get(key);
    if (timer != null) clearTimeout(timer);
    commitTimers.current.delete(key);
  };
  const commitText = (id: string, field: TierTextField, value: string) => {
    cancelCommitTimer(id, field);
    if (validateText(id, field, value)) return;
    clearTextDraft(id, field);
    setTextError(id, field, null);
    replaceTiers(
      configRef.current.tiers.map((tier) =>
        tier.id === id ? { ...tier, [field]: value.trim() } : tier
      )
    );
  };
  const handleTextChange = (id: string, field: TierTextField, value: string) => {
    setTextDrafts((prev) => ({ ...prev, [id]: { ...prev[id], [field]: value } }));
    setTextError(id, field, validateText(id, field, value));
    cancelCommitTimer(id, field);
    commitTimers.current.set(
      `${id}:${field}`,
      setTimeout(() => commitText(id, field, value), TIER_TEXT_COMMIT_DEBOUNCE_MS)
    );
  };
  const flushText = (id: string, field: TierTextField) => {
    const draft = textDraftsRef.current[id]?.[field];
    if (draft === undefined) return;
    if (validateText(id, field, draft)) {
      cancelCommitTimer(id, field);
      clearTextDraft(id, field);
      return;
    }
    commitText(id, field, draft);
  };
  useEffect(() => {
    const timers = commitTimers.current;
    return () => {
      // Unmounting mid-debounce must not lose a valid edit.
      for (const [key, timer] of timers) {
        clearTimeout(timer);
        const [id, field] = key.split(":") as [string, TierTextField];
        const draft = textDraftsRef.current[id]?.[field];
        if (draft !== undefined && !validateText(id, field, draft)) commitText(id, field, draft);
      }
      timers.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- unmount-only flush
  }, []);

  const commitEvaluationModel = () => {
    if (evaluationDraft === null) return;
    if (!evaluationValid) {
      // An invalid draft never reaches the backend; blur reverts to the saved value.
      setEvaluationDraft(null);
      return;
    }
    setEvaluationDraft(null);
    if (evaluationValue !== config.evaluationModel) {
      setConfig({ ...config, evaluationModel: evaluationValue });
    }
  };

  const writeKey = async (value: string) => {
    if (!api) return;
    setKeyBusy(true);
    setKeyError(null);
    try {
      const result = await api.providers.setProviderConfig({
        provider: TYPESAFE_PROVIDER_KEY,
        keyPath: ["apiKey"],
        value,
      });
      if (!result.success) {
        setKeyError(result.error);
        return;
      }
      setKeyDraft("");
      setStatusRefresh((count) => count + 1);
    } catch (error) {
      setKeyError(getErrorMessage(error));
    } finally {
      setKeyBusy(false);
    }
  };

  const classifySample = async () => {
    if (!api || samplePrompt.trim().length === 0) return;
    setClassifying(true);
    setPreview(null);
    setPreviewError(null);
    try {
      // Classify against the tiers and evaluator on screen: setConfig saves optimistically and
      // the write may still be in flight when the click lands.
      const result = await api.config.previewAutoModelRouting({ prompt: samplePrompt, config });
      if (result.success) setPreview(result.data);
      else setPreviewError(result.error);
    } catch (error) {
      setPreviewError(getErrorMessage(error));
    } finally {
      setClassifying(false);
    }
  };

  if (!api) {
    return (
      <div className="bg-background-secondary px-4 py-3">
        <div className="text-muted text-xs">Connect to xum to configure this setting.</div>
      </div>
    );
  }

  const evaluationStatusText = !evaluationValid
    ? EVALUATION_MODEL_ERROR
    : evaluationStatus?.evaluationModel !== evaluationValue
      ? "Checking evaluation model..."
      : evaluationStatus.available
        ? "Ready to classify prompts"
        : (evaluationStatus.reason ?? "Evaluation model unavailable");

  return (
    <div className="bg-background-secondary space-y-4 px-4 py-3" data-auto-model-routing-config>
      <p className="text-muted text-xs">
        Choose Auto for the model, the thinking level, or both in the composer. Each prompt (with up
        to {AUTO_MODEL_ROUTING_RECENT_MESSAGE_LIMIT} of your previous prompts in the workspace) is
        sent to the evaluation model, which picks a difficulty tier. The turn then runs on that
        tier&apos;s model and/or thinking level, whichever you set to Auto.
      </p>

      <div className="space-y-2">
        <label className="text-foreground block text-sm" htmlFor="auto-model-routing-evaluation">
          Evaluation model
        </label>
        <Input
          id="auto-model-routing-evaluation"
          aria-invalid={!evaluationValid}
          autoComplete="off"
          spellCheck={false}
          value={evaluationDraft ?? config.evaluationModel}
          placeholder={DEFAULT_AUTO_MODEL_ROUTING_EVALUATION_MODEL}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
            setEvaluationDraft(event.target.value)
          }
          onBlur={commitEvaluationModel}
          onKeyDown={(event: React.KeyboardEvent<HTMLInputElement>) => {
            if (event.key === "Enter") commitEvaluationModel();
            if (event.key === "Escape") setEvaluationDraft(null);
          }}
          className="border-border-medium bg-modal-bg h-9 w-full font-mono text-xs"
        />
        <div className="text-muted text-xs">
          provider:model with one of {SUPPORTED_EVALUATION_PROVIDERS}. The {TYPESAFE_PROVIDER_KEY}{" "}
          key comes from the {TYPESAFE_PROVIDER_KEY} entry in providers.jsonc or{" "}
          {TYPESAFE_API_KEY_ENV_VARS.join(", ")}; other providers use their Providers settings.
        </div>
        <div
          className={
            evaluationValid && evaluationStatus?.available !== false
              ? "text-muted text-xs"
              : "text-danger-light text-xs"
          }
          data-auto-model-routing-evaluation-status
        >
          {evaluationStatusText}
        </div>
      </div>

      {evaluationProvider === TYPESAFE_PROVIDER_KEY ? (
        <div className="space-y-2">
          <div className="text-foreground text-sm">TypeSafe API key</div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Input
              aria-label="TypeSafe API key"
              type="password"
              autoComplete="off"
              value={keyDraft}
              placeholder="Paste a TypeSafe API key"
              onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                setKeyDraft(event.target.value)
              }
              onKeyDown={(event: React.KeyboardEvent<HTMLInputElement>) => {
                if (event.key === "Enter" && keyDraft.trim().length > 0) {
                  void writeKey(keyDraft.trim());
                }
              }}
              className="border-border-medium bg-modal-bg h-9 min-w-0 flex-1"
            />
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                disabled={keyBusy || keyDraft.trim().length === 0}
                onClick={() => void writeKey(keyDraft.trim())}
              >
                Save
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={keyBusy}
                onClick={() => void writeKey("")}
              >
                Clear
              </Button>
            </div>
          </div>
          {keyError ? <div className="text-danger-light text-xs">{keyError}</div> : null}
        </div>
      ) : null}

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="text-foreground text-sm">Difficulty tiers</div>
            <div className="text-muted text-xs">
              Ordered easiest to hardest. The evaluation model picks one tier per prompt from these
              descriptions; each tier maps to a model, a thinking level, or both.
            </div>
          </div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="shrink-0"
            onClick={() => replaceTiers(getDefaultAutoModelRoutingConfig().tiers)}
          >
            <RotateCcw aria-hidden="true" />
            Reset to defaults
          </Button>
        </div>

        <div className="divide-border-light border-border-light divide-y rounded border">
          {tiers.map((tier, index) => (
            <div key={tier.id} className="space-y-2 p-3" data-auto-model-routing-tier={tier.id}>
              <div className="flex items-center gap-2">
                <Input
                  aria-label={`Tier ${index + 1} label`}
                  aria-invalid={textErrors[tier.id]?.label != null}
                  maxLength={AUTO_MODEL_ROUTING_MAX_LABEL_CHARS}
                  value={textDrafts[tier.id]?.label ?? tier.label}
                  onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                    handleTextChange(tier.id, "label", event.target.value)
                  }
                  onBlur={() => flushText(tier.id, "label")}
                  onKeyDown={(event: React.KeyboardEvent<HTMLInputElement>) => {
                    if (event.key === "Enter") flushText(tier.id, "label");
                  }}
                  className="border-border-medium bg-modal-bg h-8 min-w-0 flex-1 text-sm"
                />
                <span className="text-muted hidden font-mono text-[10px] sm:inline">{tier.id}</span>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8"
                  aria-label={`Move tier ${index + 1} up`}
                  disabled={index === 0}
                  onClick={() => moveTier(index, -1)}
                >
                  <ArrowUp aria-hidden="true" />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8"
                  aria-label={`Move tier ${index + 1} down`}
                  disabled={index === tiers.length - 1}
                  onClick={() => moveTier(index, 1)}
                >
                  <ArrowDown aria-hidden="true" />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8"
                  aria-label={`Remove tier ${index + 1}`}
                  disabled={tiers.length <= AUTO_MODEL_ROUTING_MIN_TIERS}
                  onClick={() =>
                    replaceTiers(tiers.filter((candidate) => candidate.id !== tier.id))
                  }
                >
                  <Trash2 aria-hidden="true" />
                </Button>
              </div>
              {textErrors[tier.id]?.label ? (
                <div className="text-danger-light text-xs" data-auto-model-routing-text-error>
                  {textErrors[tier.id]?.label}
                </div>
              ) : null}
              <Input
                aria-label={`Tier ${index + 1} description`}
                aria-invalid={textErrors[tier.id]?.description != null}
                maxLength={AUTO_MODEL_ROUTING_MAX_DESCRIPTION_CHARS}
                value={textDrafts[tier.id]?.description ?? tier.description}
                onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                  handleTextChange(tier.id, "description", event.target.value)
                }
                onBlur={() => flushText(tier.id, "description")}
                onKeyDown={(event: React.KeyboardEvent<HTMLInputElement>) => {
                  if (event.key === "Enter") flushText(tier.id, "description");
                }}
                className="border-border-medium bg-modal-bg h-8 w-full text-xs"
              />
              {textErrors[tier.id]?.description ? (
                <div className="text-danger-light text-xs" data-auto-model-routing-text-error>
                  {textErrors[tier.id]?.description}
                </div>
              ) : null}
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <div className="flex min-w-0 flex-1 items-center gap-1">
                  <ModelSelector
                    triggerAriaLabel={`Tier ${index + 1} model`}
                    value={tier.model ?? ""}
                    onChange={(model) => updateTier(tier.id, { model })}
                    models={models}
                    hiddenModels={hiddenModelsForSelector}
                    emptyLabel="Use selected composer model"
                    variant="box"
                    className="bg-modal-bg min-w-0"
                  />
                  {tier.model ? (
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8 shrink-0"
                      aria-label={`Clear tier ${index + 1} model`}
                      onClick={() => updateTier(tier.id, { model: undefined })}
                    >
                      <X aria-hidden="true" />
                    </Button>
                  ) : null}
                </div>
                <Select
                  value={tier.thinkingLevel ?? INHERIT_THINKING}
                  onValueChange={(value) =>
                    updateTier(tier.id, {
                      thinkingLevel: isThinkingLevel(value) ? value : undefined,
                    })
                  }
                >
                  <SelectTrigger
                    aria-label={`Tier ${index + 1} thinking level`}
                    className="border-border-medium bg-modal-bg h-9 w-full sm:w-40"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={INHERIT_THINKING}>Inherit thinking</SelectItem>
                    {THINKING_LEVELS.map((level) => (
                      <SelectItem key={level} value={level}>
                        {level}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          ))}
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={tiers.length >= AUTO_MODEL_ROUTING_MAX_TIERS}
          onClick={() => {
            const id = nextTierId(tiers);
            replaceTiers([
              ...tiers,
              {
                id,
                label: `Tier ${tiers.length + 1}`,
                description: "Describe the work this tier covers",
              },
            ]);
          }}
        >
          <Plus aria-hidden="true" />
          Add tier
        </Button>
        {writeError ? (
          <div className="text-danger-light text-xs" data-auto-model-routing-write-error>
            Could not save routing settings: {writeError}
          </div>
        ) : null}
      </div>

      <div className="space-y-2">
        <div className="text-foreground text-sm">Test routing</div>
        <textarea
          aria-label="Sample prompt"
          value={samplePrompt}
          placeholder="Paste a prompt to see which tier the evaluation model would choose"
          rows={3}
          onChange={(event) => setSamplePrompt(event.target.value)}
          className="border-border-medium bg-modal-bg text-foreground placeholder:text-muted w-full rounded border px-2 py-1 text-xs outline-none"
        />
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            disabled={classifying || samplePrompt.trim().length === 0}
            onClick={() => void classifySample()}
          >
            {classifying ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
            Classify
          </Button>
        </div>
        {previewError ? (
          <div className="text-danger-light text-xs" data-auto-model-routing-preview-error>
            {previewError}
          </div>
        ) : null}
        {preview ? (
          <div className="text-xs" data-auto-model-routing-preview>
            <div className="text-foreground">
              {preview.tierLabel}
              {preview.confidence != null
                ? ` (${formatPercent(preview.confidence)} confidence)`
                : ""}
              {preview.model
                ? ` on ${formatModelStringForDisplay(preview.model)}`
                : " (no model mapped; the composer model would be used)"}
              {preview.thinkingLevel ? `, thinking ${preview.thinkingLevel}` : ""}
            </div>
            {preview.probabilities ? (
              <div className="text-muted">
                {Object.entries(preview.probabilities)
                  .sort(([, a], [, b]) => b - a)
                  .map(([tierId, probability]) => `${tierId}: ${formatPercent(probability)}`)
                  .join(", ")}
              </div>
            ) : null}
            <div className="text-muted">
              Evaluated by {formatModelStringForDisplay(preview.evaluationModel)}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
