import {
  getAgentIdKey,
  getAutoModelRoutingKey,
  getAutoRoutingChoiceByAgentKey,
  getAutoThinkingLevelKey,
  getModelKey,
  getThinkingLevelKey,
} from "@/common/constants/storage";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { modelSelectionEqualityKey } from "@/common/utils/ai/models";
import { normalizeAgentId } from "@/common/utils/agentIds";
import type { ThinkingLevel } from "@/common/types/thinking";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";
import { isExperimentEnabled } from "@/browser/hooks/useExperiments";
import {
  readPersistedState,
  readPersistedString,
  updatePersistedState,
} from "@/browser/hooks/usePersistedState";
import type { AutoRoutingChoiceByAgent, AutoRoutingOutcome } from "@/browser/utils/workspaceModeAi";

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

export function recordWorkspaceModelChange(
  workspaceId: string,
  model: string,
  origin: ModelChangeOrigin
): void {
  if (origin === "sync") return;

  const normalized = normalizeExplicitModel(model);
  const current = readPersistedString(getModelKey(workspaceId));
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
  updatePersistedState(getModelKey(workspaceId), model);
  // An explicit concrete pick (user or agent, e.g. an accepted plan's model) leaves Auto;
  // sync-driven mode defaults keep the user's routing choice. Agent switches then apply
  // the target agent's routing via applyAutoRoutingOutcome.
  if (origin === "user") {
    setAutoRoutingChoice(workspaceId, "model", false);
  } else if (origin === "agent") {
    updatePersistedState(getAutoModelRoutingKey(workspaceId), false);
  }
}

/** The composer dimensions Auto can take over, each with its own persisted flag. */
export type AutoRoutingDimension = "model" | "thinkingLevel";

const AUTO_ROUTING_KEY_BY_DIMENSION: Record<AutoRoutingDimension, (scopeId: string) => string> = {
  model: getAutoModelRoutingKey,
  thinkingLevel: getAutoThinkingLevelKey,
};

/** Persisted-state key of one Auto dimension's flag; the palette reads and writes it outside React. */
export function getAutoRoutingKey(scopeId: string, dimension: AutoRoutingDimension): string {
  return AUTO_ROUTING_KEY_BY_DIMENSION[dimension](scopeId);
}

/**
 * Remembers a user's explicit routing pick (Auto or a concrete value) for the workspace's
 * active agent so later agent switches restore it over the agent's configured default.
 * Creation drafts and other non-workspace scopes (all `__`-prefixed) keep no picks: their
 * composer follows configured defaults, and the creation transfer records deviations.
 */
function recordAutoRoutingChoice(
  scopeId: string,
  dimension: AutoRoutingDimension,
  auto: boolean
): void {
  if (scopeId.length === 0 || scopeId.startsWith("__")) return;
  if (isExperimentEnabled(EXPERIMENT_IDS.AUTO_MODEL_ROUTING) !== true) return;
  const agentId = normalizeAgentId(
    readPersistedState<string>(getAgentIdKey(scopeId), WORKSPACE_DEFAULTS.agentId),
    WORKSPACE_DEFAULTS.agentId
  );
  recordAutoRoutingChoiceForAgent(scopeId, agentId, { [dimension]: auto });
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
      return { ...record, [agentId]: { ...record[agentId], ...choice } };
    },
    {}
  );
}

/** A user-driven Auto toggle or concrete pick for one dimension of a composer scope. */
export function setAutoRoutingChoice(
  scopeId: string,
  dimension: AutoRoutingDimension,
  active: boolean
): void {
  updatePersistedState(getAutoRoutingKey(scopeId, dimension), active);
  recordAutoRoutingChoice(scopeId, dimension, active);
}

/**
 * Applies an agent resolution's routing outcome. Call after the concrete model/thinking
 * setters: an explicit ("agent") concrete write leaves Auto, and the outcome decides
 * whether the target agent routes (its workspace pick, else its configured default).
 */
export function applyAutoRoutingOutcome(scopeId: string, outcome: AutoRoutingOutcome): void {
  for (const dimension of ["model", "thinkingLevel"] as const) {
    const active = outcome[dimension];
    if (active !== undefined) {
      updatePersistedState(getAutoRoutingKey(scopeId, dimension), active);
    }
  }
}

/**
 * Thinking counterpart of setWorkspaceModelWithOrigin for agent-resolved levels: an explicit
 * agent switch leaves thinking Auto until applyAutoRoutingOutcome applies the target agent's
 * routing; sync-driven defaults keep the user's routing choice.
 */
export function setWorkspaceThinkingLevelWithOrigin(
  workspaceId: string,
  level: ThinkingLevel,
  origin: ModelChangeOrigin
): void {
  updatePersistedState(getThinkingLevelKey(workspaceId), level);
  if (origin !== "sync") {
    updatePersistedState(getAutoThinkingLevelKey(workspaceId), false);
  }
}
