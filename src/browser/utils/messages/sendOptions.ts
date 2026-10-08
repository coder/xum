import {
  getAutoModelRoutingKey,
  getAutoThinkingLevelKey,
  getReasoningModeKey,
  getDisableWorkspaceAgentsKey,
} from "@/common/constants/storage";
import { readPersistedState } from "@/browser/hooks/usePersistedState";
import { buildSendMessageOptions } from "@/browser/utils/messages/buildSendMessageOptions";
import type { SendMessageOptions } from "@/common/orpc/types";
import { coerceOpenAIReasoningMode, type OpenAIReasoningMode } from "@/common/types/thinking";
import type { MuxProviderOptions } from "@/common/types/providerOptions";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";
import { getAppConfigStore, getUserPreferences } from "@/browser/stores/AppConfigStore";
import { readScopedAiDefault } from "@/browser/utils/scopedAiDefaults";
import { getWorkspaceAiSelection } from "@/browser/utils/workspaceAiSettingsSync";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { migrateGlobalToPerModel } from "@/browser/contexts/ProviderOptionsContext";

function getProviderOptions(): MuxProviderOptions {
  const providerOptions = getUserPreferences().ai?.providerOptions;
  return {
    anthropic: migrateGlobalToPerModel(providerOptions?.anthropic),
    google: providerOptions?.google,
  };
}

/**
 * Non-hook equivalent of useSendMessageOptions — reads current preferences from localStorage.
 * Used by compaction, resume, idle-compaction, and plan execution outside React context.
 */
export function getSendOptionsFromStorage(workspaceId: string): SendMessageOptions {
  const agentId = readScopedAiDefault(workspaceId, "agentId") ?? WORKSPACE_DEFAULTS.agentId;
  const selection = getWorkspaceAiSelection(workspaceId, agentId);

  // OpenAI pro reasoning mode (workspace-scoped); absent = standard.
  // Coerce untrusted persisted values so corrupt entries self-heal to "standard"
  // instead of failing SendMessageOptionsSchema on retry/resume/creation flows.
  const reasoningMode =
    coerceOpenAIReasoningMode(
      readPersistedState<OpenAIReasoningMode | null>(getReasoningModeKey(workspaceId), null)
    ) ?? "standard";

  const providerOptions = getProviderOptions();

  const disableWorkspaceAgents = readPersistedState<boolean>(
    getDisableWorkspaceAgentsKey(workspaceId),
    false
  );

  // Same gate as useAutoRoutingSelection: a stale persisted true must not
  // reach the backend once the experiment is off.
  const autoRoutingEnabled =
    getAppConfigStore().getSnapshot()?.experiments?.[EXPERIMENT_IDS.AUTO_MODEL_ROUTING] === true;
  const autoModelRouting =
    autoRoutingEnabled &&
    readPersistedState<boolean>(getAutoModelRoutingKey(workspaceId), false) === true;
  const autoThinkingLevel =
    autoRoutingEnabled &&
    readPersistedState<boolean>(getAutoThinkingLevelKey(workspaceId), false) === true;

  return buildSendMessageOptions({
    model: selection.model,
    agentId,
    thinkingLevel: selection.thinkingLevel,
    reasoningMode,
    providerOptions,
    disableWorkspaceAgents,
    autoModelRouting,
    autoThinkingLevel,
  });
}
