import {
  getAutoModelRoutingKey,
  getAutoThinkingLevelKey,
  getReasoningModeKey,
  getThinkingLevelByModelKey,
  getThinkingLevelKey,
  getDisableWorkspaceAgentsKey,
} from "@/common/constants/storage";
import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import { buildSendMessageOptions } from "@/browser/utils/messages/buildSendMessageOptions";
import type { SendMessageOptions } from "@/common/orpc/types";
import {
  coerceOpenAIReasoningMode,
  type OpenAIReasoningMode,
  type ThinkingLevel,
} from "@/common/types/thinking";
import type { MuxProviderOptions } from "@/common/types/providerOptions";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";
import { getAppConfigStore, getUserPreferences } from "@/browser/stores/AppConfigStore";
import { getServerScope, readScopedAiDefault } from "@/browser/utils/scopedAiDefaults";
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
  const baseModel = getWorkspaceAiSelection(workspaceId, agentId).model;

  // Read thinking level (workspace-scoped).
  // Migration: if the workspace-scoped value is missing, fall back to legacy per-model storage
  // once, then persist into the workspace-scoped key.
  const scopedKey = getThinkingLevelKey(workspaceId);
  const existingScoped = readScopedAiDefault(workspaceId, "thinkingLevel");
  // Project and global scopes are typed preferences, so only workspace scopes migrate.
  const migratesLegacyLevel =
    existingScoped === undefined && getServerScope(workspaceId) === undefined;
  const thinkingLevel =
    existingScoped ??
    (migratesLegacyLevel
      ? readPersistedState<ThinkingLevel>(
          getThinkingLevelByModelKey(baseModel),
          WORKSPACE_DEFAULTS.thinkingLevel
        )
      : WORKSPACE_DEFAULTS.thinkingLevel);
  if (migratesLegacyLevel) {
    // Best-effort: avoid losing a user's existing per-model preference.
    updatePersistedState<ThinkingLevel>(scopedKey, thinkingLevel);
  }

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
    model: baseModel,
    agentId,
    thinkingLevel,
    reasoningMode,
    providerOptions,
    disableWorkspaceAgents,
    autoModelRouting,
    autoThinkingLevel,
  });
}
