import {
  getAutoModelRoutingKey,
  getAutoThinkingLevelKey,
  getReasoningModeKey,
  getThinkingLevelByModelKey,
  getThinkingLevelKey,
  getDisableWorkspaceAgentsKey,
} from "@/common/constants/storage";
import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import { getDefaultModel } from "@/browser/hooks/useModelsFromSettings";
import {
  buildSendMessageOptions,
  normalizeModelPreference,
} from "@/browser/utils/messages/buildSendMessageOptions";
import type { SendMessageOptions } from "@/common/orpc/types";
import {
  coerceOpenAIReasoningMode,
  type OpenAIReasoningMode,
  type ThinkingLevel,
} from "@/common/types/thinking";
import type { MuxProviderOptions } from "@/common/types/providerOptions";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";
import { getAppConfigStore, getUserPreferences } from "@/browser/stores/AppConfigStore";
import { readScopedAiDefault } from "@/browser/utils/scopedAiDefaults";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";

function getProviderOptions(): MuxProviderOptions {
  const providerOptions = getUserPreferences().ai?.providerOptions;
  return { anthropic: providerOptions?.anthropic, google: providerOptions?.google };
}

/**
 * Non-hook equivalent of useSendMessageOptions — reads current preferences from localStorage.
 * Used by compaction, resume, idle-compaction, and plan execution outside React context.
 */
export function getSendOptionsFromStorage(workspaceId: string): SendMessageOptions {
  const defaultModel = getDefaultModel();
  const rawModel = readScopedAiDefault(workspaceId, "model") ?? defaultModel;
  const baseModel = normalizeModelPreference(rawModel, defaultModel);

  // Read thinking level (workspace-scoped).
  // Migration: if the workspace-scoped value is missing, fall back to legacy per-model storage
  // once, then persist into the workspace-scoped key.
  const scopedKey = getThinkingLevelKey(workspaceId);
  const existingScoped = readScopedAiDefault(workspaceId, "thinkingLevel");
  const thinkingLevel =
    existingScoped ??
    readPersistedState<ThinkingLevel>(
      getThinkingLevelByModelKey(baseModel),
      WORKSPACE_DEFAULTS.thinkingLevel
    );
  if (existingScoped === undefined) {
    // Best-effort: avoid losing a user's existing per-model preference.
    updatePersistedState<ThinkingLevel>(scopedKey, thinkingLevel);
  }

  const agentId = readScopedAiDefault(workspaceId, "agentId") ?? WORKSPACE_DEFAULTS.agentId;

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
