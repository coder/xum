import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";
import { useReasoningMode } from "./useReasoningMode";
import { useThinkingLevel } from "./useThinkingLevel";
import { useAgent } from "@/browser/contexts/AgentContext";
import { usePersistedState } from "./usePersistedState";
import {
  buildSendMessageOptions,
  normalizeModelPreference,
} from "@/browser/utils/messages/buildSendMessageOptions";
import { DEFAULT_MODEL_KEY } from "@/common/constants/storage";
import { useScopedAiDefault } from "@/browser/utils/scopedAiDefaults";
import type { SendMessageOptions } from "@/common/orpc/types";
import { useProviderOptions } from "./useProviderOptions";
import { useExperimentValue } from "./useExperiments";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { useWorkspaceContext } from "@/browser/contexts/WorkspaceContext";
import { resolveEffectiveComposerModel } from "@/browser/utils/workspaceAiSettingsSync";
import {
  getAutoRoutingKey,
  setAutoRoutingChoice,
  type AutoRoutingDimension,
} from "@/browser/utils/modelChange";

/**
 * Extended send options that includes both the canonical model used for backend routing
 * and a base model string for UI components that need a stable display value.
 */
export interface SendMessageOptionsWithBase extends SendMessageOptions {
  /** Base model in canonical format (e.g., "openai:gpt-5.1-codex-max") for UI/policy checks */
  baseModel: string;
}

/**
 * Ignores persisted Auto while the experiment is disabled. In workspace scopes, user
 * updates also record the active agent's routing choice.
 */
export function useAutoRoutingSelection(
  workspaceId: string,
  dimension: AutoRoutingDimension
): [active: boolean, setActive: (active: boolean) => void] {
  const experimentEnabled = useExperimentValue(EXPERIMENT_IDS.AUTO_MODEL_ROUTING);
  const [persisted] = usePersistedState<boolean>(getAutoRoutingKey(workspaceId, dimension), false, {
    listener: true,
  });
  return [
    experimentEnabled && persisted === true,
    (active) => setAutoRoutingChoice(workspaceId, dimension, active),
  ];
}

/**
 * Single source of truth for message send options (ChatInput, RetryBarrier, etc.).
 * Subscribes to persisted preferences so model/thinking/agent changes propagate automatically.
 */
export function useSendMessageOptions(workspaceId: string): SendMessageOptionsWithBase {
  const [thinkingLevel] = useThinkingLevel();
  const [reasoningMode] = useReasoningMode();
  const { agentId, disableWorkspaceAgents } = useAgent();
  const { workspaceMetadata } = useWorkspaceContext();
  const { options: providerOptions } = useProviderOptions();

  // Subscribe to the global default model preference so backend-seeded values apply
  // immediately on fresh origins (e.g., when switching ports).
  const [defaultModelPref] = usePersistedState<string>(
    DEFAULT_MODEL_KEY,
    WORKSPACE_DEFAULTS.model,
    { listener: true }
  );
  const defaultModel = normalizeModelPreference(defaultModelPref, WORKSPACE_DEFAULTS.model);

  // Workspace-scoped model preference. If unset, fall back to metadata, then global default.
  const preferredModel = useScopedAiDefault(workspaceId, "model") ?? null;

  const [autoModelRouting] = useAutoRoutingSelection(workspaceId, "model");
  const [autoThinkingLevel] = useAutoRoutingSelection(workspaceId, "thinkingLevel");

  // Prefer metadata over the global default until workspace localStorage seeding catches up.
  const baseModel = resolveEffectiveComposerModel(
    preferredModel,
    workspaceMetadata.get(workspaceId),
    agentId,
    defaultModel
  );

  const options = buildSendMessageOptions({
    agentId,
    thinkingLevel,
    reasoningMode,
    model: baseModel,
    providerOptions,
    disableWorkspaceAgents,
    autoModelRouting,
    autoThinkingLevel,
  });

  return {
    ...options,
    baseModel,
  };
}
