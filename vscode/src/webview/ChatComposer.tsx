import { useMemo, useState } from "react";

import { SendHorizontal } from "lucide-react";

import type { StreamingMessageAggregator } from "xum/browser/utils/messages/StreamingMessageAggregator";
import { getSendOptionsFromStorage } from "xum/browser/utils/messages/sendOptions";

import { matchesKeybind, formatKeybind, KEYBINDS } from "xum/browser/utils/ui/keybinds";
import { CUSTOM_EVENTS, createCustomEvent } from "xum/common/constants/events";
import { useAPI } from "xum/browser/contexts/API";
import { useAgent } from "xum/browser/contexts/AgentContext";
import { useThinkingLevel } from "xum/browser/hooks/useThinkingLevel";
import { useReasoningMode } from "xum/browser/hooks/useReasoningMode";
import type { WorkspaceAISettingsCache } from "xum/browser/utils/workspaceModeAi";
import { normalizeAgentId } from "xum/common/utils/agentIds";
import { ThinkingProvider } from "xum/browser/contexts/ThinkingContext";
import { usePersistedState, updatePersistedState } from "xum/browser/hooks/usePersistedState";
import { useModelsFromSettings } from "xum/browser/hooks/useModelsFromSettings";
import { useProvidersConfig } from "xum/browser/hooks/useProvidersConfig";
import { usePolicy } from "xum/browser/contexts/PolicyContext";
import { normalizeSelectedModel } from "xum/common/utils/ai/models";
import {
  consumeAiSelectionIntent,
  getAiSelectionIntentForSendOptions,
  markAiSelectionIntent,
} from "xum/browser/utils/aiSelectionIntent";
import assert from "xum/common/utils/assert";
import { useProviderOptions } from "xum/browser/hooks/useProviderOptions";
import { useAutoCompactionSettings } from "xum/browser/hooks/useAutoCompactionSettings";

import { VimTextArea } from "xum/browser/components/VimTextArea/VimTextArea";
import { ModelSelector } from "xum/browser/components/ModelSelector/ModelSelector";
import { ThinkingSelector } from "xum/browser/components/ThinkingSelector/ThinkingSelector";
import { ContextUsageIndicatorButton } from "xum/browser/components/ContextUsageIndicatorButton/ContextUsageIndicatorButton";
import { Tooltip, TooltipTrigger, TooltipContent } from "xum/browser/components/Tooltip/Tooltip";

import type { AgentId } from "xum/common/types/agentDefinition";

import { calculateTokenMeterData } from "xum/common/utils/tokens/tokenMeterUtils";
import { createDisplayUsage } from "xum/common/utils/tokens/displayUsage";
import type { ChatUsageDisplay } from "xum/common/utils/tokens/usageAggregator";
import { cn } from "xum/common/lib/utils";
import {
  VIM_ENABLED_KEY,
  getInputKey,
  getModelKey,
  getWorkspaceAISettingsByAgentKey,
} from "xum/common/constants/storage";

const SEND_MESSAGE_TIMEOUT_MS = 30_000;

// #4781: at most one AI-settings-persisting send per workspace may be unresolved, so an earlier
// write can never land after a later pick's. The backend saves the settings before sendMessage
// returns, so a server reply (success or failure) settles the entry. "unknown": a persisting send
// ended without a reply (timeout abort or transport error), so its write may still land; later
// sends for that workspace do not persist until the webview reloads (fail closed; the picks still
// apply to the turns). Module scope, because the composer remounts per workspace.
const aiPersistenceByWorkspace = new Map<string, "in-flight" | "unknown">();

/**
 * Simple agent toggle for VS Code extension (no agent discovery).
 * Just toggles between Exec and Plan agents.
 */
function SimpleAgentToggle(props: {
  agentId: AgentId;
  onChange: (agentId: AgentId) => void;
  /** Sub-agent workspaces keep the agent they were created with (#4738). */
  disabled: boolean;
}) {
  const isPlan = props.agentId === "plan";
  // Seeded workspace settings can name a custom agent (e.g. a sub-agent's "explore"); show it as
  // is rather than mislabeling it as Exec.
  const label = isPlan ? "Plan" : props.agentId === "exec" ? "Exec" : props.agentId;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          disabled={props.disabled}
          onClick={() => props.onChange(isPlan ? "exec" : "plan")}
          className={cn(
            "rounded-sm px-1.5 py-0.5 text-[11px] font-medium transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-50",
            isPlan
              ? "bg-plan-mode text-white hover:bg-plan-mode-hover"
              : "bg-exec-mode text-white hover:bg-exec-mode-hover"
          )}
        >
          {label}
        </button>
      </TooltipTrigger>
      <TooltipContent align="center">
        Click to switch to {isPlan ? "Exec" : "Plan"} agent
      </TooltipContent>
    </Tooltip>
  );
}

function getLastContextUsage(
  aggregator: StreamingMessageAggregator,
  fallbackModel: string | null
): ChatUsageDisplay | undefined {
  const messages = aggregator.getAllMessages();

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];

    if (msg.role !== "assistant") {
      continue;
    }

    if (msg.metadata?.compacted) {
      continue;
    }

    const rawUsage = msg.metadata?.contextUsage;
    if (!rawUsage) {
      continue;
    }

    const providerMetadata =
      msg.metadata?.contextProviderMetadata ?? msg.metadata?.providerMetadata;
    const model = msg.metadata?.model ?? fallbackModel ?? "unknown";

    return createDisplayUsage(rawUsage, model, providerMetadata);
  }

  return undefined;
}

function ChatComposerInner(props: {
  workspaceId: string;
  disabled: boolean;
  disabledReason?: string | undefined;
  aggregator: StreamingMessageAggregator | null;
  /** The workspace's own AI settings are loaded; until then nothing may be persisted (#4781). */
  aiSettingsLoaded: boolean;
  /** AgentProvider has a workspace scope; an unscoped toggle would write the global agent key. */
  agentScoped: boolean;
  /** The oldest held input, which the held-input shortcuts act on (#4771). */
  heldInputId?: string | undefined;
  onSendComplete: () => void;
  onNotice: (notice: { level: "info" | "error"; message: string }) => void;
}): JSX.Element {
  const apiState = useAPI();
  const api = apiState.api;

  const { agentId, setAgentId, isAgentSelectionLocked } = useAgent();
  const [thinkingLevel] = useThinkingLevel();
  const [reasoningMode] = useReasoningMode();

  const { options: providerOptions } = useProviderOptions();
  const use1M = providerOptions.anthropic?.use1MContext ?? false;

  const {
    models,
    customModels,
    hiddenModels,
    hideModel,
    unhideModel,
    ensureModelInSettings,
    defaultModel,
    setDefaultModel,
    isAllowedByPolicyOnActiveRoute,
  } = useModelsFromSettings();

  const modelKey = getModelKey(props.workspaceId);
  const [preferredModel, setPreferredModel] = usePersistedState<string>(modelKey, defaultModel, {
    listener: true,
  });

  // Gateway-preserving, like the desktop composer: an explicit gateway pick (e.g.
  // openrouter:openai/gpt-5) stays selected instead of showing as its direct-provider model.
  const storedModel = normalizeSelectedModel(preferredModel);

  // #4808: the stored model can be one the admin policy excludes (persisted earlier, seeded from the
  // workspace, or revoked by a policy refresh), and every send with it fails with policy_denied.
  // Fall back to the first allowed model for display and send, without writing it anywhere: the
  // webview does not persist AI settings, and the stored choice comes back if the policy allows it
  // again. With no allowed model in the list, nothing changes and the backend decides. Either way,
  // a status line says so. The check is route-aware, like the model list, because the backend
  // enforces policy after routing; it uses the gateway-preserving identity so an explicitly pinned
  // gateway model is checked on that gateway.
  // The status line names this identity too, so a denied gateway pin is not shown as its canonical ID.
  const storedSelection = normalizeSelectedModel(preferredModel);
  const storedModelAllowed = isAllowedByPolicyOnActiveRoute(storedSelection);
  // Until the providers config arrives, the model list is not filtered by provider availability,
  // so a fallback could pick a provider without credentials; substitute nothing until then.
  const { config: providersConfig } = useProvidersConfig();
  // Until the first policy.get settles, the policy looks disabled and the model list is unfiltered.
  const { loading: policyLoading } = usePolicy();
  const policyFallbackModel =
    storedModelAllowed || providersConfig === null
      ? null
      : (models.find((model) => isAllowedByPolicyOnActiveRoute(model)) ?? null);
  const baseModel = storedModelAllowed ? storedModel : (policyFallbackModel ?? storedModel);

  const inputKey = getInputKey(props.workspaceId);
  const [input, setInput] = usePersistedState<string>(inputKey, "", { listener: true });

  const [vimEnabled, setVimEnabled] = usePersistedState<boolean>(VIM_ENABLED_KEY, false, {
    listener: true,
  });
  const [isSending, setIsSending] = useState(false);

  const aggregator = props.aggregator;
  const canInterruptStream = Boolean(aggregator?.getActiveStreamMessageId());
  const isCompactingStream = aggregator?.isCompacting() ?? false;
  const usageModelFromAggregator = aggregator?.getCurrentModel() ?? null;

  // Note: avoid memoizing against the aggregator reference.
  // The aggregator mutates in-place as events stream in.
  const lastContextUsage = aggregator
    ? getLastContextUsage(aggregator, usageModelFromAggregator)
    : undefined;

  const liveUsage = (() => {
    if (!aggregator) {
      return undefined;
    }

    const activeStreamMessageId = aggregator.getActiveStreamMessageId();
    if (!activeStreamMessageId) {
      return undefined;
    }

    const model = usageModelFromAggregator;
    if (!model) {
      return undefined;
    }

    const rawUsage = aggregator.getActiveStreamUsage(activeStreamMessageId);
    const providerMetadata = aggregator.getActiveStreamStepProviderMetadata(activeStreamMessageId);

    return rawUsage ? createDisplayUsage(rawUsage, model, providerMetadata) : undefined;
  })();

  const lastUsage = liveUsage ?? lastContextUsage;
  const usageModel = lastUsage?.model ?? usageModelFromAggregator;

  const contextUsageData = useMemo(() => {
    return lastUsage
      ? calculateTokenMeterData(lastUsage, usageModel ?? "unknown", use1M, false)
      : { segments: [], totalTokens: 0, totalPercentage: 0 };
  }, [lastUsage, usageModel, use1M]);

  const autoCompactionSettings = useAutoCompactionSettings(props.workspaceId, usageModel);

  const canSend =
    !props.disabled &&
    !isSending &&
    input.trim().length > 0 &&
    apiState.status === "connected" &&
    Boolean(api);

  const onModelChange = (model: string) => {
    // The desktop's setPreferredModel semantics (ChatInput): keep an explicit gateway route, and
    // record the deliberate pick so a sub-agent's metadata refresh keeps it until a send carries it.
    const selectedModel = normalizeSelectedModel(model);
    ensureModelInSettings(selectedModel);
    markAiSelectionIntent(props.workspaceId, "model", selectedModel);
    setPreferredModel(selectedModel);

    // Like the desktop composer, record the pick in the active agent's cache so
    // WorkspaceModeAISync restores it (not the seeded model) after switching agents and back.
    updatePersistedState<WorkspaceAISettingsCache>(
      getWorkspaceAISettingsByAgentKey(props.workspaceId),
      (prev) => ({
        ...(prev && typeof prev === "object" ? prev : {}),
        [normalizeAgentId(agentId, "exec")]: {
          model: selectedModel,
          thinkingLevel,
          reasoningMode,
        },
      }),
      {}
    );

    // #4781: nothing is written here; the next send persists the pick (desktop parity).
  };

  const cycleModels = customModels.length > 0 ? customModels : models;

  const cycleToNextModel = () => {
    if (cycleModels.length < 2) {
      return;
    }

    const currentIndex = cycleModels.indexOf(baseModel);
    const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % cycleModels.length;
    const nextModel = cycleModels[nextIndex];
    if (nextModel) {
      onModelChange(nextModel);
    }
  };

  const onSend = async () => {
    // Re-check at dispatch: the composer can be disabled (e.g. history replay not caught up)
    // after the keystroke or click that triggered this send. Like the disabled Send button (and the
    // desktop composer), Enter must not start a second send while one is in flight.
    if (props.disabled || isSending) {
      return;
    }
    const trimmed = input.trim();
    if (!trimmed) {
      return;
    }

    if (trimmed === "/vim") {
      const next = !vimEnabled;
      setVimEnabled(next);
      setInput("");
      props.onNotice({ level: "info", message: `Vim mode ${next ? "enabled" : "disabled"}.` });
      return;
    }

    if (!api) {
      props.onNotice({ level: "error", message: "Not connected to Xum server." });
      return;
    }

    setIsSending(true);
    setInput("");

    const restoreTrimmedIfSafe = () => {
      // Avoid clobbering a new draft typed while the request is in flight.
      setInput((current) => (current.trim().length === 0 ? trimmed : current));
    };

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => {
      controller.abort();
    }, SEND_MESSAGE_TIMEOUT_MS);

    const baseOptions = {
      ...getSendOptionsFromStorage(props.workspaceId),
      // The effective agent: for a sub-agent workspace, the locked agent (#4738), not a local pick.
      agentId,
    };
    // #4781: persist only explicit picks, through the desktop's send-time path (the backend saves the
    // sent settings unless skipAiSettingsPersistence; aiSelectionIntent pins them on a sub-agent).
    // Never seeded values (no pending pick), never before the workspace's settings are loaded
    // (#4755), never before the admin policy has loaded or for a policy-excluded or fallback model
    // (#4808), and never while an earlier persisting send for this workspace is unresolved. The
    // thinking level is sent as selected; the backend applies the authoritative floor.
    const mayPersist =
      props.aiSettingsLoaded &&
      !policyLoading &&
      storedModelAllowed &&
      !aiPersistenceByWorkspace.has(props.workspaceId);
    const aiSelection = getAiSelectionIntentForSendOptions(props.workspaceId, agentId, {
      ...baseOptions,
      skipAiSettingsPersistence: !mayPersist,
    });
    const persist = aiSelection.intent !== undefined;
    assert(!persist || policyFallbackModel === null, "a policy fallback model must never be persisted");
    if (persist) {
      aiPersistenceByWorkspace.set(props.workspaceId, "in-flight");
    }

    try {
      const options = {
        ...baseOptions,
        skipAiSettingsPersistence: !persist,
        ...(persist ? { aiSelectionIntent: aiSelection.intent } : {}),
        // Only when the stored model is policy-excluded; otherwise keep the stored model string.
        ...(policyFallbackModel ? { model: policyFallbackModel } : {}),
      };

      const result = await api.workspace.sendMessage(
        {
          workspaceId: props.workspaceId,
          message: trimmed,
          options,
        },
        { signal: controller.signal }
      );
      if (persist) {
        // The server replied, so this send's settings write has landed (or was skipped).
        aiPersistenceByWorkspace.delete(props.workspaceId);
      }

      if (!result.success) {
        const errorString =
          typeof result.error === "string" ? result.error : JSON.stringify(result.error, null, 2);
        props.onNotice({ level: "error", message: `Send failed: ${errorString}` });
        restoreTrimmedIfSafe();
        return;
      }

      if (persist) {
        // A pick made while this send was in flight has a newer token and stays pending.
        consumeAiSelectionIntent(props.workspaceId, agentId, aiSelection.attachedTokens);
      }
      props.onSendComplete();
    } catch (error) {
      if (persist) {
        aiPersistenceByWorkspace.set(props.workspaceId, "unknown");
      }
      if (controller.signal.aborted) {
        props.onNotice({
          level: "error",
          message: `Send timed out after ${SEND_MESSAGE_TIMEOUT_MS / 1000}s. Try again.`,
        });
        restoreTrimmedIfSafe();
        return;
      }

      const errorString = error instanceof Error ? error.message : String(error);
      props.onNotice({ level: "error", message: `Send failed: ${errorString}` });
      restoreTrimmedIfSafe();
    } finally {
      clearTimeout(timeoutId);
      setIsSending(false);
    }
  };

  const placeholder = (() => {
    if (props.disabled) {
      const disabledReason = props.disabledReason;
      if (typeof disabledReason === "string" && disabledReason.trim().length > 0) {
        return disabledReason;
      }
    }

    if (isCompactingStream) {
      const interruptKeybind = vimEnabled
        ? KEYBINDS.INTERRUPT_STREAM_VIM
        : KEYBINDS.INTERRUPT_STREAM_NORMAL;
      return `Compacting... (${formatKeybind(interruptKeybind)} cancel | ${formatKeybind(KEYBINDS.SEND_MESSAGE)} to queue)`;
    }

    const hints: string[] = [];
    if (canInterruptStream) {
      const interruptKeybind = vimEnabled
        ? KEYBINDS.INTERRUPT_STREAM_VIM
        : KEYBINDS.INTERRUPT_STREAM_NORMAL;
      hints.push(`${formatKeybind(interruptKeybind)} to interrupt`);
    }

    hints.push(
      `${formatKeybind(KEYBINDS.SEND_MESSAGE)} to ${canInterruptStream ? "queue" : "send"}`
    );
    hints.push(`Click model to choose, ${formatKeybind(KEYBINDS.CYCLE_MODEL)} to cycle`);
    hints.push(`/vim to toggle Vim mode (${vimEnabled ? "on" : "off"})`);

    return `Type a message... (${hints.join(", ")})`;
  })();

  return (
    <div className="flex flex-col gap-2">
      <VimTextArea
        value={input}
        onChange={setInput}
        placeholder={placeholder}
        disabled={props.disabled}
        onKeyDown={(e) => {
          if (matchesKeybind(e, KEYBINDS.CYCLE_MODEL)) {
            e.preventDefault();
            cycleToNextModel();
            return;
          }

          // Same held-input shortcuts as the desktop composer: only from an empty composer, and
          // routed to the HeldInput banner so they share its in-flight guard and error display.
          const heldAction = matchesKeybind(e, KEYBINDS.SEND_HELD_INPUT)
            ? "send"
            : matchesKeybind(e, KEYBINDS.DISCARD_HELD_INPUT)
              ? "discard"
              : null;
          if (heldAction != null && props.heldInputId != null && input.trim() === "") {
            e.preventDefault();
            if (e.repeat) return;
            window.dispatchEvent(
              createCustomEvent(CUSTOM_EVENTS.HELD_INPUT_ACTION, {
                workspaceId: props.workspaceId,
                heldInputId: props.heldInputId,
                action: heldAction,
              })
            );
            return;
          }

          if (matchesKeybind(e, KEYBINDS.SEND_MESSAGE)) {
            e.preventDefault();
            void onSend();
          }
        }}
      />

      <div className="flex flex-col gap-2">
        {storedModelAllowed ? null : (
          <div role="status" className="text-content-secondary text-[11px]">
            {policyFallbackModel
              ? `Admin policy does not allow ${storedSelection}; using ${policyFallbackModel}.`
              : `Admin policy does not allow ${storedSelection}. Choose an allowed model.`}
          </div>
        )}
        <div className="w-full min-w-0" data-component="ModelSelectorGroup">
          <ModelSelector
            value={baseModel}
            onChange={onModelChange}
            models={models}
            hiddenModels={hiddenModels}
            defaultModel={defaultModel}
            onSetDefaultModel={setDefaultModel}
            onHideModel={hideModel}
            onUnhideModel={unhideModel}
          />
        </div>

        <div className="@container flex items-center justify-between gap-2">
          <div className="flex shrink-0 items-center overflow-visible">
            <ThinkingSelector modelString={baseModel} allowProMode={false} allowFastMode={false} />
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            <ContextUsageIndicatorButton
              data={contextUsageData}
              autoCompaction={autoCompactionSettings}
            />
            <SimpleAgentToggle
              agentId={agentId}
              onChange={setAgentId}
              disabled={isAgentSelectionLocked === true || !props.agentScoped}
            />

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => void onSend()}
                  disabled={!canSend}
                  aria-label="Send message"
                  className={cn(
                    "inline-flex items-center gap-1 rounded-sm border border-border-light px-1.5 py-0.5 text-[11px] font-medium text-white transition-colors duration-200 disabled:opacity-50",
                    agentId === "plan"
                      ? "bg-plan-mode hover:bg-plan-mode-hover disabled:hover:bg-plan-mode"
                      : "bg-exec-mode hover:bg-exec-mode-hover disabled:hover:bg-exec-mode"
                  )}
                >
                  <SendHorizontal className="h-3.5 w-3.5" strokeWidth={2.5} />
                </button>
              </TooltipTrigger>
              <TooltipContent align="center">
                Send message ({formatKeybind(KEYBINDS.SEND_MESSAGE)})
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ChatComposer(props: {
  workspaceId: string;
  disabled: boolean;
  disabledReason?: string | undefined;
  aggregator: StreamingMessageAggregator | null;
  /** The workspace's own AI settings are loaded; until then nothing may be persisted (#4781). */
  aiSettingsLoaded: boolean;
  agentScoped: boolean;
  heldInputId?: string | undefined;
  onSendComplete: () => void;
  onNotice: (notice: { level: "info" | "error"; message: string }) => void;
}): JSX.Element {
  // AgentProvider is mounted by App so the transcript shares it (#4711).
  return (
    <ThinkingProvider workspaceId={props.workspaceId}>
      <ChatComposerInner
        workspaceId={props.workspaceId}
        disabled={props.disabled}
        disabledReason={props.disabledReason}
        aggregator={props.aggregator}
        aiSettingsLoaded={props.aiSettingsLoaded}
        agentScoped={props.agentScoped}
        heldInputId={props.heldInputId}
        onSendComplete={props.onSendComplete}
        onNotice={props.onNotice}
      />
    </ThinkingProvider>
  );
}
