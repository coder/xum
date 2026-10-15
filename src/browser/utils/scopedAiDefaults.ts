import { useSyncExternalStore } from "react";
import {
  getUserPreferences,
  updateUserPreferences,
  useUserPreferences,
} from "@/browser/stores/AppConfigStore";
import {
  getAgentScope,
  getWorkspaceAgentId,
  setWorkspaceAgentPick,
  subscribeAiSelection,
} from "@/browser/utils/aiSelectionIntent";
import type { UserPreferences } from "@/common/config/schemas/userPreferences";
import { getCreationDraftStore } from "@/browser/stores/CreationDraftStore";
import {
  getCreationDraftScopeId,
  getProjectScopeId,
  GLOBAL_SCOPE_ID,
  parseCreationDraftScopeId,
} from "@/common/constants/storage";
import { normalizeAgentId } from "@/common/utils/agentIds";
import { ownExecution } from "@/common/utils/drafts";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";

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

/**
 * A creation draft owns its choices (the record): they travel with a project change and never
 * write the project's defaults. A draft without an agent shows its project's default agent.
 */
function readCreationDraftDefault<F extends ScopedAiField>(
  draftId: string,
  field: F,
  preferences: UserPreferences
): AiDefaults[F] {
  const draft = getCreationDraftStore().getView(draftId).draft;
  if (!draft) return undefined;
  const value: AiDefaults = {
    model: draft.ai.model,
    thinkingLevel: draft.ai.thinkingLevel,
    agentId:
      ownExecution(draft)?.agent?.id ??
      preferences.ai?.projectDefaults?.[draft.projectPath]?.agentId,
  };
  return value[field];
}

function writeCreationDraftDefault<F extends ScopedAiField>(
  draftId: string,
  field: F,
  value: AiDefaults[F]
): void {
  const store = getCreationDraftStore();
  const draft = store.getView(draftId).draft;
  if (!draft) return;
  if (field !== "agentId") {
    store.update(draftId, { ai: { ...draft.ai, [field]: value } });
    return;
  }
  store.updateExecution(draftId, {
    agent:
      typeof value === "string"
        ? // Unknown scope counts as project-specific: a project change resets it.
          { id: value, scope: getAgentScope(getCreationDraftScopeId(draftId), value) ?? "project" }
        : null,
  });
}

export function readScopedAiDefault<F extends ScopedAiField>(
  scopeId: string,
  field: F
): AiDefaults[F] {
  const draftId = parseCreationDraftScopeId(scopeId);
  if (draftId !== null) return readCreationDraftDefault(draftId, field, getUserPreferences());
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
  const draftId = parseCreationDraftScopeId(scopeId);
  if (draftId !== null) {
    writeCreationDraftDefault(draftId, field, value);
    return;
  }
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
  // A workspace without a saved agent shows the project or global default agent.
  useUserPreferences((preferences) => preferences.ai);
  const workspaceValue = useSyncExternalStore(subscribeAiSelection, () =>
    scope ? undefined : readWorkspaceDefault(scopeId, field)
  );
  const draftId = parseCreationDraftScopeId(scopeId);
  const draftValue = useSyncExternalStore(
    (listener) =>
      draftId === null ? () => undefined : getCreationDraftStore().subscribe(draftId, listener),
    () =>
      draftId === null ? undefined : readCreationDraftDefault(draftId, field, getUserPreferences())
  );
  if (draftId !== null) return draftValue;
  return scope ? serverValue : workspaceValue;
}

/** The scope's agent as AgentProvider shows it: a project without one inherits the global agent. */
function resolveScopeAgentId(
  scoped: string | undefined,
  globalAgentId: string | undefined
): string {
  return (
    normalizeAgentId(scoped, "") || normalizeAgentId(globalAgentId, WORKSPACE_DEFAULTS.agentId)
  );
}

export function readScopeAgentId(scopeId: string): string {
  return resolveScopeAgentId(
    readScopedAiDefault(scopeId, "agentId"),
    readScopedAiDefault(GLOBAL_SCOPE_ID, "agentId")
  );
}

export function useScopeAgentId(scopeId: string): string {
  return resolveScopeAgentId(
    useScopedAiDefault(scopeId, "agentId"),
    useScopedAiDefault(GLOBAL_SCOPE_ID, "agentId")
  );
}
