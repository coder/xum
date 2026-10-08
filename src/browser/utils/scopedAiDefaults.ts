import { useSyncExternalStore } from "react";
import {
  getUserPreferences,
  updateUserPreferences,
  useUserPreferences,
} from "@/browser/stores/AppConfigStore";
import {
  getWorkspaceAgentId,
  setWorkspaceAgentPick,
  subscribeAiSelection,
} from "@/browser/utils/aiSelectionIntent";
import type { UserPreferences } from "@/common/config/schemas/userPreferences";
import { getProjectScopeId, GLOBAL_SCOPE_ID } from "@/common/constants/storage";

// Global defaults have no model, so a global model read is always undefined.
type AiDefaults = NonNullable<NonNullable<UserPreferences["ai"]>["projectDefaults"]>[string];
type ScopedAiField = keyof AiDefaults;

const PROJECT_SCOPE_PREFIX = getProjectScopeId("");

/**
 * Project and global scopes are config.json preferences. A workspace scope resolves only its
 * agent (unsent pick, then metadata); its model and thinking come from resolveWorkspaceAiSelection.
 */
function getServerScope(scopeId: string): { projectPath?: string } | undefined {
  if (scopeId === GLOBAL_SCOPE_ID) return {};
  return scopeId.startsWith(PROJECT_SCOPE_PREFIX)
    ? { projectPath: scopeId.slice(PROJECT_SCOPE_PREFIX.length) }
    : undefined;
}

function selectServerDefault<F extends ScopedAiField>(
  preferences: UserPreferences,
  scope: { projectPath?: string },
  field: F
): AiDefaults[F] {
  const defaults: AiDefaults | undefined =
    scope.projectPath === undefined
      ? preferences.ai?.globalDefaults
      : preferences.ai?.projectDefaults?.[scope.projectPath];
  return defaults?.[field];
}

export function readScopedAiDefault<F extends ScopedAiField>(
  scopeId: string,
  field: F
): AiDefaults[F] {
  const scope = getServerScope(scopeId);
  if (scope) {
    return selectServerDefault(getUserPreferences(), scope, field);
  }
  return readWorkspaceDefault(scopeId, field);
}

function readWorkspaceDefault<F extends ScopedAiField>(scopeId: string, field: F): AiDefaults[F] {
  const value: AiDefaults = field === "agentId" ? { agentId: getWorkspaceAgentId(scopeId) } : {};
  return value[field];
}

export function writeScopedAiDefault<F extends ScopedAiField>(
  scopeId: string,
  field: F,
  value: AiDefaults[F]
): void {
  const scope = getServerScope(scopeId);
  if (!scope) {
    // A workspace agent pick stays in memory until a send stores it in workspace metadata.
    if (field === "agentId" && typeof value === "string") setWorkspaceAgentPick(scopeId, value);
    return;
  }
  const defaults = { [field]: value ?? null };
  updateUserPreferences({
    ai:
      scope.projectPath === undefined
        ? { globalDefaults: defaults }
        : { projectDefaults: { [scope.projectPath]: defaults } },
  });
}

export function useScopedAiDefault<F extends ScopedAiField>(
  scopeId: string,
  field: F
): AiDefaults[F] {
  const scope = getServerScope(scopeId);
  const serverValue = useUserPreferences((preferences) =>
    scope ? selectServerDefault(preferences, scope, field) : undefined
  );
  const workspaceValue = useSyncExternalStore(subscribeAiSelection, () =>
    scope ? undefined : readWorkspaceDefault(scopeId, field)
  );
  return scope ? serverValue : workspaceValue;
}
