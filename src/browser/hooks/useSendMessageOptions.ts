import { useReasoningMode } from "./useReasoningMode";
import { useThinkingLevel } from "./useThinkingLevel";
import { useAgent, useOptionalAgent } from "@/browser/contexts/AgentContext";
import { buildSendMessageOptions } from "@/browser/utils/messages/buildSendMessageOptions";
import type { SendMessageOptions } from "@/common/orpc/types";
import { useProviderOptions } from "./useProviderOptions";
import { useExperimentValue } from "./useExperiments";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { useAutoRouting, useWorkspaceAiSelection } from "@/browser/utils/workspaceAiSettingsSync";
import { setAutoRoutingChoice } from "@/browser/utils/modelChange";
import type { AutoRoutingDimension } from "@/browser/utils/aiSelectionIntent";

/**
 * Extended send options that includes both the canonical model used for backend routing
 * and a base model string for UI components that need a stable display value.
 */
export interface SendMessageOptionsWithBase extends SendMessageOptions {
  /** Base model in canonical format (e.g., "openai:gpt-5.1-codex-max") for UI/policy checks */
  baseModel: string;
}

/** Ignores saved Auto while the experiment is disabled. */
export function useAutoRoutingSelection(
  workspaceId: string,
  dimension: AutoRoutingDimension
): [active: boolean, setActive: (active: boolean) => void] {
  const experimentEnabled = useExperimentValue(EXPERIMENT_IDS.AUTO_MODEL_ROUTING);
  const agents = useOptionalAgent()?.agents ?? [];
  const active = useAutoRouting(
    workspaceId,
    dimension,
    new Map(agents.map((agent) => [agent.id, agent.base]))
  );
  return [
    experimentEnabled && active,
    (next) => setAutoRoutingChoice(workspaceId, dimension, next),
  ];
}

/**
 * Single source of truth for message send options (ChatInput, RetryBarrier, etc.).
 * Subscribes to persisted preferences so model/thinking/agent changes propagate automatically.
 */
export function useSendMessageOptions(workspaceId: string): SendMessageOptionsWithBase {
  const [thinkingLevel] = useThinkingLevel();
  const [reasoningMode] = useReasoningMode();
  const { agentId, agents } = useAgent();
  const { options: providerOptions } = useProviderOptions();

  const { model: baseModel, serviceTier } = useWorkspaceAiSelection(
    workspaceId,
    agentId,
    new Map(agents.map((agent) => [agent.id, agent.base]))
  );

  const [autoModelRouting] = useAutoRoutingSelection(workspaceId, "model");
  const [autoThinkingLevel] = useAutoRoutingSelection(workspaceId, "thinkingLevel");

  const options = buildSendMessageOptions({
    agentId,
    thinkingLevel,
    reasoningMode,
    serviceTier,
    model: baseModel,
    providerOptions,
    autoModelRouting,
    autoThinkingLevel,
  });

  return {
    ...options,
    baseModel,
  };
}
