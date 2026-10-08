import { useSyncExternalStore } from "react";
import { normalizeModelPreference } from "@/browser/utils/messages/buildSendMessageOptions";
import {
  getAgentBases,
  getAiSelectionVersion,
  getPendingAiSelection,
  getWorkspaceAiMetadata,
  subscribeAiSelection,
} from "@/browser/utils/aiSelectionIntent";
import { resolveConfiguredAiDefaults } from "@/browser/utils/workspaceModeAi";
import { readScopedAiDefault, useScopedAiDefault } from "@/browser/utils/scopedAiDefaults";
import { getDefaultModel } from "@/browser/hooks/useModelsFromSettings";
import { readPersistedState, usePersistedState } from "@/browser/hooks/usePersistedState";
import { getReasoningModeKey } from "@/common/constants/storage";
import {
  getAppConfigStore,
  getUserPreferences,
  useAgentAiDefaults,
  useAppConfig,
  useUserPreferences,
} from "@/browser/stores/AppConfigStore";
import type { UserPreferences } from "@/common/config/schemas/userPreferences";
import type { AgentAiDefaults } from "@/common/types/agentAiDefaults";
import {
  coerceOpenAIReasoningMode,
  coerceThinkingLevel,
  type OpenAIReasoningMode,
  type ThinkingLevel,
} from "@/common/types/thinking";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { isValidModelFormat } from "@/common/utils/ai/models";
import { normalizeAgentId } from "@/common/utils/agentIds";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";

export interface WorkspaceAiSelection {
  model: string;
  thinkingLevel: ThinkingLevel;
  reasoningMode: OpenAIReasoningMode;
}

interface WorkspaceAiSelectionInput {
  workspaceId: string;
  agentId: string;
  ai: UserPreferences["ai"];
  defaultModel: string;
  agentAiDefaults: AgentAiDefaults;
  agentBaseById?: ReadonlyMap<string, string | undefined>;
}

/**
 * Per field: the unsent pick, the workspace's saved settings for the agent, the agent's
 * configured defaults, then project and global defaults.
 */
function resolveWorkspaceAiSelection(input: WorkspaceAiSelectionInput): WorkspaceAiSelection {
  const agentId = normalizeAgentId(input.agentId, WORKSPACE_DEFAULTS.agentId);
  const pick = (field: keyof WorkspaceAiSelection) =>
    getPendingAiSelection(input.workspaceId, agentId, field);
  const metadata = getWorkspaceAiMetadata(input.workspaceId);
  const saved = metadata?.aiSettingsByAgent?.[agentId] ?? metadata?.aiSettings;
  const configured = resolveConfiguredAiDefaults(
    agentId,
    input.agentAiDefaults,
    input.agentBaseById ?? getAgentBases(input.workspaceId)
  );
  const project =
    metadata?.projectPath != null ? input.ai?.projectDefaults?.[metadata.projectPath] : undefined;

  const model = [pick("model"), saved?.model, configured.modelString, project?.model].find(
    (candidate): candidate is string => candidate != null && isValidModelFormat(candidate.trim())
  );
  const thinkingLevel =
    [pick("thinkingLevel"), saved?.thinkingLevel, configured.thinkingLevel, project?.thinkingLevel]
      .map(coerceThinkingLevel)
      .find((level) => level != null) ??
    coerceThinkingLevel(input.ai?.globalDefaults?.thinkingLevel) ??
    WORKSPACE_DEFAULTS.thinkingLevel;
  // A saved per-agent bucket owns the reasoning choice: its absent mode means standard.
  const reasoningMode =
    coerceOpenAIReasoningMode(pick("reasoningMode")) ??
    (saved != null ? coerceOpenAIReasoningMode(saved.reasoningMode) : configured.reasoningMode) ??
    "standard";
  return {
    model: normalizeModelPreference(model, input.defaultModel),
    thinkingLevel,
    reasoningMode,
  };
}

function isCreationScope(scopeId: string): boolean {
  return scopeId.startsWith("__");
}

function resolveCreationScopeSelection(
  scoped: {
    model: string | undefined;
    thinkingLevel: ThinkingLevel | undefined;
    reasoningMode: OpenAIReasoningMode | null;
  },
  defaultModel: string
): WorkspaceAiSelection {
  return {
    model: normalizeModelPreference(scoped.model, defaultModel),
    thinkingLevel: scoped.thinkingLevel ?? WORKSPACE_DEFAULTS.thinkingLevel,
    // Coerce untrusted persisted values so corrupt entries self-heal to "standard".
    reasoningMode: coerceOpenAIReasoningMode(scoped.reasoningMode) ?? "standard",
  };
}

/**
 * Non-React reader; agentId defaults to the workspace's selected agent. Creation composers
 * pass their project, global or draft scope (workspace ids never start with "__").
 */
export function getWorkspaceAiSelection(
  workspaceId: string,
  agentId = readScopedAiDefault(workspaceId, "agentId") ?? WORKSPACE_DEFAULTS.agentId,
  agentBaseById?: ReadonlyMap<string, string | undefined>
): WorkspaceAiSelection {
  if (isCreationScope(workspaceId)) {
    return resolveCreationScopeSelection(
      {
        model: readScopedAiDefault(workspaceId, "model"),
        thinkingLevel: readScopedAiDefault(workspaceId, "thinkingLevel"),
        reasoningMode: readPersistedState<OpenAIReasoningMode | null>(
          getReasoningModeKey(workspaceId),
          null
        ),
      },
      getDefaultModel()
    );
  }
  return resolveWorkspaceAiSelection({
    workspaceId,
    agentId,
    ai: getUserPreferences().ai,
    defaultModel: getDefaultModel(),
    agentAiDefaults: getAppConfigStore().getSnapshot()?.agentAiDefaults ?? {},
    agentBaseById,
  });
}

export function useWorkspaceAiSelection(
  workspaceId: string,
  agentId?: string,
  agentBaseById?: ReadonlyMap<string, string | undefined>
): WorkspaceAiSelection {
  useSyncExternalStore(subscribeAiSelection, getAiSelectionVersion);
  const selectedAgentId = useScopedAiDefault(workspaceId, "agentId");
  // Subscribed for creation scopes, which resolve like getWorkspaceAiSelection.
  const scopedModel = useScopedAiDefault(workspaceId, "model");
  const scopedThinkingLevel = useScopedAiDefault(workspaceId, "thinkingLevel");
  const [scopedReasoningMode] = usePersistedState<OpenAIReasoningMode | null>(
    getReasoningModeKey(workspaceId),
    null,
    { listener: true }
  );
  const ai = useUserPreferences((preferences) => preferences.ai);
  const agentAiDefaults = useAgentAiDefaults();
  const defaultModel = normalizeModelPreference(
    useAppConfig((config) => config.defaultModel),
    WORKSPACE_DEFAULTS.model
  );
  if (isCreationScope(workspaceId)) {
    return resolveCreationScopeSelection(
      {
        model: scopedModel,
        thinkingLevel: scopedThinkingLevel,
        reasoningMode: scopedReasoningMode,
      },
      defaultModel
    );
  }
  return resolveWorkspaceAiSelection({
    workspaceId,
    agentId: agentId ?? selectedAgentId ?? WORKSPACE_DEFAULTS.agentId,
    ai,
    defaultModel,
    agentAiDefaults,
    agentBaseById,
  });
}

export function getWorkspaceAiSettingsFromMetadata(
  metadata: FrontendWorkspaceMetadata | undefined,
  agentId: string | undefined
): {
  model: string | undefined;
  thinkingLevel: ThinkingLevel | undefined;
  reasoningMode: OpenAIReasoningMode | undefined;
} {
  const settings =
    (agentId ? metadata?.aiSettingsByAgent?.[agentId] : undefined) ?? metadata?.aiSettings;
  return {
    model: settings?.model,
    thinkingLevel: settings?.thinkingLevel,
    reasoningMode: settings?.reasoningMode,
  };
}

export function resolveEffectiveComposerModel(
  preferredModel: unknown,
  metadata: FrontendWorkspaceMetadata | undefined,
  agentId: string | undefined,
  defaultModel: string
): string {
  const metadataModel = getWorkspaceAiSettingsFromMetadata(metadata, agentId).model;
  // Match ChatInput precedence so shortcuts and palette actions gate on the model users see.
  return normalizeModelPreference(preferredModel, metadataModel ?? defaultModel);
}
