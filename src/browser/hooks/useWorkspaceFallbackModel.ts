import { usePersistedState } from "./usePersistedState";
import { normalizeToCanonical } from "@/common/utils/ai/models";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";
import { getModelKey } from "@/common/constants/storage";
import { useAppConfig } from "@/browser/stores/AppConfigStore";

/**
 * Resolves the effective model for a workspace by combining the global default
 * model preference with the workspace-scoped preference.
 *
 * This subscribes to both storage keys with `{ listener: true }` so changes
 * (including backend-seeded values on fresh origins) propagate immediately.
 */
export function useWorkspaceFallbackModel(workspaceId: string): string {
  const defaultModelPref = useAppConfig((config) => config.defaultModel) ?? "";
  const defaultModel = normalizeToCanonical(defaultModelPref).trim() || WORKSPACE_DEFAULTS.model;

  // Workspace-scoped model preference. If unset, fall back to the global default model.
  // Note: we intentionally *don't* pass defaultModel as the usePersistedState initialValue;
  // initialValue is sticky and would lock in the fallback before startup seeding.
  const [preferredModel] = usePersistedState<string | null>(getModelKey(workspaceId), null, {
    listener: true,
  });

  if (typeof preferredModel === "string" && preferredModel.trim().length > 0) {
    return normalizeToCanonical(preferredModel.trim());
  }
  return defaultModel;
}
