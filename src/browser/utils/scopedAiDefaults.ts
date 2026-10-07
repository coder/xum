import {
  readPersistedState,
  updatePersistedState,
  usePersistedState,
} from "@/browser/hooks/usePersistedState";
import {
  getUserPreferences,
  updateUserPreferences,
  useUserPreferences,
} from "@/browser/stores/AppConfigStore";
import type { UserPreferences } from "@/common/config/schemas/userPreferences";
import {
  getAgentIdKey,
  getModelKey,
  getProjectScopeId,
  getThinkingLevelKey,
  GLOBAL_SCOPE_ID,
} from "@/common/constants/storage";

// Global defaults have no model, so a global model read is always undefined.
type AiDefaults = NonNullable<NonNullable<UserPreferences["ai"]>["projectDefaults"]>[string];
type ScopedAiField = keyof AiDefaults;

const STORAGE_KEYS: Record<ScopedAiField, (scopeId: string) => string> = {
  agentId: getAgentIdKey,
  model: getModelKey,
  thinkingLevel: getThinkingLevelKey,
};

const PROJECT_SCOPE_PREFIX = getProjectScopeId("");

/** Project and global scopes are config.json preferences; workspace and draft scopes stay local. */
export function getServerScope(scopeId: string): { projectPath?: string } | undefined {
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
  return readPersistedState<AiDefaults[F]>(STORAGE_KEYS[field](scopeId), undefined);
}

export function writeScopedAiDefault<F extends ScopedAiField>(
  scopeId: string,
  field: F,
  value: AiDefaults[F]
): void {
  const scope = getServerScope(scopeId);
  if (!scope) {
    updatePersistedState(STORAGE_KEYS[field](scopeId), value);
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
  const [localValue] = usePersistedState<AiDefaults[F]>(STORAGE_KEYS[field](scopeId), undefined, {
    listener: true,
  });
  return scope ? serverValue : localValue;
}
