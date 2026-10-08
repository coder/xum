import { useReasoningMode } from "./useReasoningMode";
import { useThinkingLevel } from "./useThinkingLevel";
import { useAgent } from "@/browser/contexts/AgentContext";
import { usePersistedState } from "./usePersistedState";
import { buildSendMessageOptions } from "@/browser/utils/messages/buildSendMessageOptions";
import type { SendMessageOptions } from "@/common/orpc/types";
import { useProviderOptions } from "./useProviderOptions";
import { useExperimentValue } from "./useExperiments";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { useWorkspaceAiSelection } from "@/browser/utils/workspaceAiSettingsSync";
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
  const { agentId, agents, disableWorkspaceAgents } = useAgent();
  const { options: providerOptions } = useProviderOptions();

  const baseModel = useWorkspaceAiSelection(
    workspaceId,
    agentId,
    new Map(agents.map((agent) => [agent.id, agent.base]))
  ).model;

  const [autoModelRouting] = useAutoRoutingSelection(workspaceId, "model");
  const [autoThinkingLevel] = useAutoRoutingSelection(workspaceId, "thinkingLevel");

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
