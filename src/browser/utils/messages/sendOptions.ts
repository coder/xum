import { buildSendMessageOptions } from "@/browser/utils/messages/buildSendMessageOptions";
import type { SendMessageOptions } from "@/common/orpc/types";
import type { MuxProviderOptions } from "@/common/types/providerOptions";
import { getAppConfigStore, getUserPreferences } from "@/browser/stores/AppConfigStore";
import { readScopeAgentId } from "@/browser/utils/scopedAiDefaults";
import { getAutoRouting, getWorkspaceAiSelection } from "@/browser/utils/workspaceAiSettingsSync";
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
 * Non-hook equivalent of useSendMessageOptions: resolves the current picks and preferences.
 * Used by compaction, resume, idle-compaction, and plan execution outside React context.
 */
export function getSendOptionsFromStorage(workspaceId: string): SendMessageOptions {
  const agentId = readScopeAgentId(workspaceId);
  const selection = getWorkspaceAiSelection(workspaceId, agentId);

  const providerOptions = getProviderOptions();

  // Same gate as useAutoRoutingSelection: a saved true must not reach the backend
  // once the experiment is off.
  const autoRoutingEnabled =
    getAppConfigStore().getSnapshot()?.experiments?.[EXPERIMENT_IDS.AUTO_MODEL_ROUTING] === true;
  const autoModelRouting = autoRoutingEnabled && getAutoRouting(workspaceId, "model", agentId);
  const autoThinkingLevel =
    autoRoutingEnabled && getAutoRouting(workspaceId, "thinkingLevel", agentId);

  return buildSendMessageOptions({
    ...selection,
    agentId,
    providerOptions,
    autoModelRouting,
    autoThinkingLevel,
  });
}
