import { ServiceTierSchema, type ServiceTier } from "@/common/config/schemas/providersConfig";
import { useSyncExternalStore } from "react";
import { normalizeModelPreference } from "@/browser/utils/messages/buildSendMessageOptions";
import {
  AUTO_ROUTING_FLAG,
  getAgentBases,
  getAiSelectionVersion,
  getAutoRoutingPick,
  getPendingAiSelection,
  getSavedAiSettings,
  getWorkspaceAgentId,
  getWorkspaceAiMetadata,
  subscribeAiSelection,
  type AutoRoutingDimension,
} from "@/browser/utils/aiSelectionIntent";
import { resolveConfiguredAiDefaults } from "@/browser/utils/workspaceModeAi";
import {
  readScopeAgentId,
  readScopedAiDefault,
  useScopeAgentId,
  useScopedAiDefault,
} from "@/browser/utils/scopedAiDefaults";
import { getDefaultModel } from "@/browser/hooks/useModelsFromSettings";
import { isNonWorkspaceScopeId } from "@/common/constants/storage";
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
import { isValidModelFormat } from "@/common/utils/ai/models";
import { normalizeAgentId } from "@/common/utils/agentIds";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";

export interface WorkspaceAiSelection {
  model: string;
  thinkingLevel: ThinkingLevel;
  reasoningMode: OpenAIReasoningMode;
  serviceTier?: ServiceTier;
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
  const saved = getSavedAiSettings(input.workspaceId, agentId);
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
    serviceTier:
      ServiceTierSchema.safeParse(pick("serviceTier")).data ??
      ServiceTierSchema.safeParse(saved?.serviceTier).data,
  };
}

function resolveCreationScopeSelection(
  scopeId: string,
  scoped: { model: string | undefined; thinkingLevel: ThinkingLevel | undefined },
  defaultModel: string
): WorkspaceAiSelection {
  return {
    model: normalizeModelPreference(scoped.model, defaultModel),
    thinkingLevel: scoped.thinkingLevel ?? WORKSPACE_DEFAULTS.thinkingLevel,
    serviceTier: ServiceTierSchema.safeParse(
      getPendingAiSelection(scopeId, getWorkspaceAgentId(scopeId), "serviceTier")
    ).data,
    // A creation scope's reasoning mode is only an unsent pick.
    reasoningMode:
      coerceOpenAIReasoningMode(
        getPendingAiSelection(scopeId, getWorkspaceAgentId(scopeId), "reasoningMode")
      ) ?? "standard",
  };
}

/**
 * Non-React reader; agentId defaults to the workspace's selected agent. Creation composers
 * pass their project, global or draft scope.
 */
export function getWorkspaceAiSelection(
  workspaceId: string,
  agentId = readScopedAiDefault(workspaceId, "agentId") ?? WORKSPACE_DEFAULTS.agentId,
  agentBaseById?: ReadonlyMap<string, string | undefined>
): WorkspaceAiSelection {
  if (isNonWorkspaceScopeId(workspaceId)) {
    return resolveCreationScopeSelection(
      workspaceId,
      {
        model: readScopedAiDefault(workspaceId, "model"),
        thinkingLevel: readScopedAiDefault(workspaceId, "thinkingLevel"),
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
  const ai = useUserPreferences((preferences) => preferences.ai);
  const agentAiDefaults = useAgentAiDefaults();
  const defaultModel = normalizeModelPreference(
    useAppConfig((config) => config.defaultModel),
    WORKSPACE_DEFAULTS.model
  );
  if (isNonWorkspaceScopeId(workspaceId)) {
    return resolveCreationScopeSelection(
      workspaceId,
      { model: scopedModel, thinkingLevel: scopedThinkingLevel },
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

/** The unsent pick, then the agent's saved flag (a saved bucket owns it), then configured Auto. */
function resolveAutoRouting(input: {
  scopeId: string;
  dimension: AutoRoutingDimension;
  agentId: string;
  agentAiDefaults: AgentAiDefaults;
  agentBaseById?: ReadonlyMap<string, string | undefined>;
}): boolean {
  const agentId = normalizeAgentId(input.agentId, WORKSPACE_DEFAULTS.agentId);
  const flag = AUTO_ROUTING_FLAG[input.dimension];
  const saved = getSavedAiSettings(input.scopeId, agentId);
  return (
    getAutoRoutingPick(input.scopeId, agentId, input.dimension) ??
    (saved != null
      ? saved[flag] === true
      : resolveConfiguredAiDefaults(
          agentId,
          input.agentAiDefaults,
          input.agentBaseById ?? getAgentBases(input.scopeId)
        )[flag] === true)
  );
}

export function getAutoRouting(
  scopeId: string,
  dimension: AutoRoutingDimension,
  agentId = readScopeAgentId(scopeId),
  agentBaseById?: ReadonlyMap<string, string | undefined>
): boolean {
  return resolveAutoRouting({
    scopeId,
    dimension,
    agentId,
    agentAiDefaults: getAppConfigStore().getSnapshot()?.agentAiDefaults ?? {},
    agentBaseById,
  });
}

export function useAutoRouting(
  scopeId: string,
  dimension: AutoRoutingDimension,
  agentBaseById?: ReadonlyMap<string, string | undefined>
): boolean {
  useSyncExternalStore(subscribeAiSelection, getAiSelectionVersion);
  const agentId = useScopeAgentId(scopeId);
  const agentAiDefaults = useAgentAiDefaults();
  return resolveAutoRouting({
    scopeId,
    dimension,
    agentId,
    agentAiDefaults,
    agentBaseById,
  });
}
