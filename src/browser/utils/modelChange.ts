import {
  AUTO_ROUTING_CHOICE_BY_AGENT_MAX_CHARS,
  getAutoModelRoutingKey,
  getAutoRoutingChoiceByAgentKey,
  getAutoThinkingLevelKey,
} from "@/common/constants/storage";
import { modelSelectionEqualityKey } from "@/common/utils/ai/models";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { readScopedAiDefault, writeScopedAiDefault } from "@/browser/utils/scopedAiDefaults";
import {
  markAiSelectionIntent,
  setAutoRoutingPick,
  type AutoRoutingDimension,
} from "@/browser/utils/aiSelectionIntent";
import { getWorkspaceAiSelection } from "@/browser/utils/workspaceAiSettingsSync";
import type { AutoRoutingChoiceByAgent } from "@/browser/utils/workspaceModeAi";
import { withRecordEntry } from "@/browser/utils/boundedPersistedValue";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";

export type ModelChangeOrigin = "user" | "agent" | "sync";

interface ExplicitModelChange {
  model: string;
  origin: ModelChangeOrigin;
  previousModel: string | null;
}

// User request: keep origin tracking in-memory so UI-only warnings don't add persistence complexity.
const pendingExplicitChanges = new Map<string, ExplicitModelChange>();

// Coder identities stay raw so switches between coder:<instance>/<model> and the
// direct <provider>:<model> are tracked as explicit actions; passthrough gateway
// aliases (mux-gateway:openai/x) still collapse so persisted rewrites keep matching.
const normalizeExplicitModel = (model: string): string => modelSelectionEqualityKey(model);

/** Workspace ids never start with "__"; project, global and draft scopes do. */
const isWorkspaceScope = (scopeId: string): boolean => !scopeId.startsWith("__");

export function recordWorkspaceModelChange(
  workspaceId: string,
  model: string,
  origin: ModelChangeOrigin,
  current = isWorkspaceScope(workspaceId)
    ? getWorkspaceAiSelection(workspaceId).model
    : readScopedAiDefault(workspaceId, "model")
): void {
  if (origin === "sync") return;

  const normalized = normalizeExplicitModel(model);
  const normalizedCurrent = current ? normalizeExplicitModel(current) : null;

  // Avoid leaving stale explicit-change entries when the effective model doesn't change
  // (ex: user re-selects the current model, or callers pass gateway-vs-canonical equivalents).
  // Without this guard, a later sync-driven away→back transition could incorrectly consume the
  // lingering entry and surface a warning that wasn't explicitly triggered.
  if (normalizedCurrent === normalized) {
    return;
  }

  pendingExplicitChanges.set(workspaceId, {
    model: normalized,
    origin,
    previousModel: normalizedCurrent,
  });
}

export function consumeWorkspaceModelChange(
  workspaceId: string,
  model: string
): ModelChangeOrigin | null {
  const entry = pendingExplicitChanges.get(workspaceId);
  if (!entry) return null;

  const normalized = normalizeExplicitModel(model);

  if (entry.model === normalized) {
    pendingExplicitChanges.delete(workspaceId);
    return entry.origin;
  }

  // If the store reports the model from before the explicit change (e.g., rapid A→B selection
  // where we briefly observe A while tracking B), keep the newest entry.
  if (entry.previousModel === normalized) {
    return null;
  }

  // Model diverged somewhere else; the entry is stale and should not be consumed later.
  pendingExplicitChanges.delete(workspaceId);
  return null;
}

export function setWorkspaceModelWithOrigin(
  workspaceId: string,
  model: string,
  origin: ModelChangeOrigin
): void {
  recordWorkspaceModelChange(workspaceId, model, origin);
  // A workspace pick stays in memory until a send persists it into workspace metadata.
  if (!isWorkspaceScope(workspaceId)) {
    writeScopedAiDefault(workspaceId, "model", model);
  } else if (origin === "user") {
    markAiSelectionIntent(workspaceId, "model", model);
  }
  if (origin === "user") {
    setAutoRoutingChoice(workspaceId, "model", false);
  }
}

const AUTO_ROUTING_KEY_BY_DIMENSION: Record<AutoRoutingDimension, (scopeId: string) => string> = {
  model: getAutoModelRoutingKey,
  thinkingLevel: getAutoThinkingLevelKey,
};

export function getAutoRoutingKey(scopeId: string, dimension: AutoRoutingDimension): string {
  return AUTO_ROUTING_KEY_BY_DIMENSION[dimension](scopeId);
}

export function recordAutoRoutingChoiceForAgent(
  workspaceId: string,
  agentId: string,
  choice: Partial<Record<AutoRoutingDimension, boolean>>
): void {
  updatePersistedState<AutoRoutingChoiceByAgent>(
    getAutoRoutingChoiceByAgentKey(workspaceId),
    (prev) => {
      const record: AutoRoutingChoiceByAgent = prev && typeof prev === "object" ? prev : {};
      const choices: Record<string, Partial<Record<AutoRoutingDimension, boolean>>> = {};
      for (const [id, value] of Object.entries(record)) if (value) choices[id] = value;
      // One entry per agent ever chosen: keep the most recently chosen agents inside the key
      // budget so the newest choices always persist (an over-budget value would not survive reload).
      return withRecordEntry(
        choices,
        agentId,
        { ...record[agentId], ...choice },
        AUTO_ROUTING_CHOICE_BY_AGENT_MAX_CHARS
      );
    },
    {}
  );
}

/** Records an unsent Auto pick for the scope's selected agent. */
export function setAutoRoutingChoice(
  scopeId: string,
  dimension: AutoRoutingDimension,
  active: boolean
): void {
  const agentId = readScopedAiDefault(scopeId, "agentId") ?? WORKSPACE_DEFAULTS.agentId;
  setAutoRoutingPick(scopeId, agentId, dimension, active);
}
