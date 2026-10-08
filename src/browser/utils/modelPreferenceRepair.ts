import type { WorkspaceAISettingsCache } from "@/browser/utils/workspaceModeAi";
import {
  readPersistedState,
  readPersistedString,
  updatePersistedState,
} from "@/browser/hooks/usePersistedState";
import {
  LAST_CUSTOM_MODEL_PROVIDER_KEY,
  getModelKey,
  getWorkspaceAISettingsByAgentKey,
} from "@/common/constants/storage";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";
import { modelStringStartsWithProvider } from "@/common/utils/providers/modelString";
import { dropPendingModelPicks } from "@/browser/utils/aiSelectionIntent";

// Browser repair only: removing a custom provider updates config on the backend,
// but per-origin persisted browser preferences can still reference provider-owned models.
type UnknownRecord = Record<string, unknown>;

type WorkspaceAISettingsRepairEntry = Partial<NonNullable<WorkspaceAISettingsCache[string]>> &
  UnknownRecord;
type WorkspaceAISettingsRepairCache = Record<string, WorkspaceAISettingsRepairEntry | undefined>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function repairPersistedModelString(key: string, provider: string, replacement: string): void {
  const model = readPersistedString(key);
  if (model !== undefined && modelStringStartsWithProvider(model, provider)) {
    updatePersistedState(key, replacement);
  }
}

function repairLastCustomModelProvider(provider: string): void {
  const lastProvider = readPersistedString(LAST_CUSTOM_MODEL_PROVIDER_KEY);
  if (lastProvider === provider && lastProvider !== "") {
    updatePersistedState(LAST_CUSTOM_MODEL_PROVIDER_KEY, "");
  }
}

function repairWorkspaceAISettingsByAgent(workspaceId: string, provider: string): void {
  const key = getWorkspaceAISettingsByAgentKey(workspaceId);
  const settingsByAgent = readPersistedState<WorkspaceAISettingsRepairCache | undefined>(
    key,
    undefined
  );
  if (!isRecord(settingsByAgent)) {
    return;
  }

  let changed = false;
  const nextSettingsByAgent: WorkspaceAISettingsRepairCache = { ...settingsByAgent };

  for (const [agentName, settings] of Object.entries(settingsByAgent)) {
    if (!isRecord(settings)) {
      continue;
    }

    const model = settings.model;
    if (typeof model !== "string" || !modelStringStartsWithProvider(model, provider)) {
      continue;
    }

    nextSettingsByAgent[agentName] = {
      ...settings,
      model: WORKSPACE_DEFAULTS.model,
    };
    changed = true;
  }

  if (changed) {
    updatePersistedState(key, nextSettingsByAgent);
  }
}

export function repairLocalModelPreferencesForRemovedProvider(
  provider: string,
  workspaceIds: Iterable<string>
): void {
  repairLastCustomModelProvider(provider);

  for (const workspaceId of new Set(workspaceIds)) {
    repairPersistedModelString(getModelKey(workspaceId), provider, WORKSPACE_DEFAULTS.model);
    repairWorkspaceAISettingsByAgent(workspaceId, provider);
  }
  dropPendingModelPicks((model) => modelStringStartsWithProvider(model, provider));
}
