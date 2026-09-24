/**
 * Pure AI-settings planning for reawakened sub-agents.
 *
 * When an ancestor reawakens a new-style sub-agent (one carrying `taskAiPins`),
 * its model, thinking level and reasoning mode are re-resolved from the current
 * settings with spawn precedence: pins, then configured defaults, then the
 * child's current values as a reactivation-only fallback. TaskService plans the
 * snapshot under its locks without I/O; WorkspaceTurnManager commits it in the
 * same config transform that claims the new execution, after re-checking that
 * the inputs captured here have not changed (see computeReawakenInputsKey).
 *
 * No service dependencies: TaskService and WorkspaceTurnManager both import it.
 */

import type { ProvidersConfigMap } from "@/common/orpc/types";
import {
  taskAiPinsToLayer,
  targetWorkspaceBucketToLayer,
  type AgentAiSettingsLayerValues,
} from "@/common/types/agentAiSettings";
import {
  coerceOpenAIReasoningMode,
  coerceThinkingLevel,
  type OpenAIReasoningMode,
  type ThinkingLevel,
} from "@/common/types/thinking";
import { normalizeAgentId } from "@/common/utils/agentIds";
import { normalizeSelectedModel } from "@/common/utils/ai/models";
import assert from "@/common/utils/assert";
import type { Config, Workspace as WorkspaceConfigEntry } from "@/node/config";
import {
  resolveNodeAgentAiSettingsWithLayers,
  type AgentDefinitionAiLayers,
} from "@/node/services/agentDefinitions/resolveNodeAgentAiSettings";
import { log } from "@/node/services/log";
import { coerceNonEmptyString, findWorkspaceEntry } from "@/node/services/taskUtils";
import {
  resolveTaskAgentIdForResume,
  type ResolvedWorkspaceAiSettings,
} from "@/node/services/taskWorkspaceSeam";

type LoadedConfig = ReturnType<Config["loadConfigOrDefault"]>;

/** AI settings one reawakened execution runs with; mirrors creation's conventions. */
export interface AgentTaskTurnAiSnapshot {
  agentId: string;
  /** Selected, gateway-preserving model (persisted as taskModelString, sent to the turn). */
  taskModelString: string;
  /** Effective model (persisted into aiSettings). */
  canonicalModel: string;
  /** Effective (clamped) thinking level. */
  thinkingLevel: ThinkingLevel;
  /** Selected reasoning mode; "standard" when nothing configures one. */
  reasoningMode: OpenAIReasoningMode;
}

/** Transient commit payload handed from TaskService to createWorkspaceTurn. */
export interface AgentTaskTurnAi {
  snapshot: AgentTaskTurnAiSnapshot;
  inputsKey: string;
  contextKey: string;
}

/** Definition layers read outside the locks for one reawakening candidate. */
export interface PreparedReawakenAi {
  taskId: string;
  agentId: string;
  contextKey: string;
  /** null when the definition chain was unavailable (read failed or timed out). */
  layers: AgentDefinitionAiLayers | null;
}

export type ReawakenAiPlan =
  | { kind: "legacy" }
  | { kind: "stale" }
  | {
      kind: "resolved";
      snapshot: AgentTaskTurnAiSnapshot;
      inputsKey: string;
      usedDefinitionLayers: boolean;
    };

/** JSON serialization with sorted object keys, so equal inputs always produce equal keys. */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, raw: unknown) => {
    if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return raw;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(raw).sort()) {
      sorted[key] = (raw as Record<string, unknown>)[key];
    }
    return sorted;
  });
}

/** Identity of the checkout (and discovery flags) the definition layers were read from. */
export function buildReawakenContextKey(
  entry: { projectPath: string; workspace: WorkspaceConfigEntry },
  includeAgentPlugins: boolean
): string {
  return stableStringify({
    runtimeConfig: entry.workspace.runtimeConfig ?? null,
    projectPath: entry.projectPath,
    name: entry.workspace.name ?? null,
    path: entry.workspace.path ?? null,
    subProjectPath: entry.workspace.subProjectPath ?? null,
    includeAgentPlugins,
  });
}

/**
 * Every config input planReawakenAi reads. The execution-claim transform
 * recomputes it from the config it commits: a pin, bucket, parent or defaults
 * change after planning refuses the commit instead of being overwritten.
 * Returns null when the child entry is missing.
 */
export function computeReawakenInputsKey(
  config: LoadedConfig,
  taskId: string,
  contextKey: string
): string | null {
  assert(taskId.length > 0, "computeReawakenInputsKey: taskId must be non-empty");
  const child = findWorkspaceEntry(config, taskId)?.workspace;
  if (child == null) return null;
  const agentId = resolveTaskAgentIdForResume(child);
  const parent =
    child.parentWorkspaceId != null
      ? findWorkspaceEntry(config, child.parentWorkspaceId)?.workspace
      : undefined;
  return stableStringify({
    child: {
      agentId,
      parentWorkspaceId: child.parentWorkspaceId ?? null,
      taskAiPins: child.taskAiPins ?? null,
      bucket: child.aiSettingsByAgent?.[agentId] ?? null,
      aiSettings: child.aiSettings ?? null,
      taskModelString: child.taskModelString ?? null,
      taskThinkingLevel: child.taskThinkingLevel ?? null,
    },
    parent:
      parent != null
        ? {
            agentId: parent.agentId ?? null,
            agentType: parent.agentType ?? null,
            aiSettingsByAgent: parent.aiSettingsByAgent ?? null,
            aiSettings: parent.aiSettings ?? null,
          }
        : null,
    agentAiDefaults: config.agentAiDefaults ?? null,
    minThinkingLevelByModel: config.minThinkingLevelByModel ?? null,
    contextKey,
  });
}

/**
 * The calling chat's raw persisted Exec choice. Display metadata synthesizes
 * Exec/Plan buckets from legacy aiSettings; only raw persisted Exec choices may
 * outrank global Exec defaults.
 */
export function resolveParentWorkspaceExecSettings(
  parent:
    | {
        agentId?: string;
        agentType?: string;
        aiSettingsByAgent?: Record<string, ResolvedWorkspaceAiSettings>;
        aiSettings?: ResolvedWorkspaceAiSettings;
      }
    | undefined
): AgentAiSettingsLayerValues | undefined {
  const settings =
    parent?.aiSettingsByAgent?.exec ??
    (normalizeAgentId(parent?.agentId ?? parent?.agentType, "") === "exec"
      ? parent?.aiSettings
      : undefined);
  // A saved workspace's omitted reasoning mode means Standard, not inheritance.
  return settings ? targetWorkspaceBucketToLayer(settings) : undefined;
}

/**
 * Parent-workspace fallback layers (unified precedence tier 7) for a task: the
 * parent's bucket for the TARGET agent, then the parent's ACTIVE agent bucket
 * (the user toggles settings on the active agent, so the target bucket rarely
 * exists), then legacy workspace settings.
 */
export function buildParentAiSettingsFallbacks(
  parentMeta: {
    agentId?: string;
    aiSettingsByAgent?: Record<string, ResolvedWorkspaceAiSettings>;
    aiSettings?: ResolvedWorkspaceAiSettings;
  },
  targetAgentId: string
): AgentAiSettingsLayerValues[] {
  const layers: AgentAiSettingsLayerValues[] = [];
  const push = (settings: ResolvedWorkspaceAiSettings | undefined) => {
    if (!settings) return;
    layers.push({
      model: settings.model,
      thinkingLevel: coerceThinkingLevel(settings.thinkingLevel),
      reasoningMode: coerceOpenAIReasoningMode(settings.reasoningMode),
    });
  };
  const normalizedTarget = normalizeAgentId(targetAgentId, "");
  push(normalizedTarget ? parentMeta.aiSettingsByAgent?.[normalizedTarget] : undefined);
  push(parentMeta.aiSettingsByAgent?.[normalizeAgentId(parentMeta.agentId)]);
  push(parentMeta.aiSettings);
  return layers;
}

/**
 * Plans the AI settings for an ancestor-triggered reawakening. Synchronous and
 * pure (debug logging aside) so it can run under the task locks.
 *
 * Outcomes: legacy (no taskAiPins; caller keeps the existing frozen path),
 * stale (the prepared layers came from a different agent or checkout; caller
 * refuses retryably), or resolved (with prepared layers, or best-effort without
 * them when the definition read was not prepared, failed or timed out).
 */
export function planReawakenAi(params: {
  config: LoadedConfig;
  taskId: string;
  prepared: PreparedReawakenAi | undefined;
  freshContextKey: string;
  providersConfig: ProvidersConfigMap | null;
}): ReawakenAiPlan {
  const { config, taskId, prepared, freshContextKey } = params;
  const entry = findWorkspaceEntry(config, taskId);
  assert(entry != null, `planReawakenAi: task ${taskId} must exist`);
  const child = entry.workspace;
  if (child.taskAiPins == null) return { kind: "legacy" };

  const agentId = resolveTaskAgentIdForResume(child);
  if (
    prepared != null &&
    (prepared.taskId !== taskId ||
      prepared.agentId !== agentId ||
      prepared.contextKey !== freshContextKey)
  ) {
    return { kind: "stale" };
  }

  const parent =
    child.parentWorkspaceId != null
      ? findWorkspaceEntry(config, child.parentWorkspaceId)?.workspace
      : undefined;
  const bucket = child.aiSettingsByAgent?.[agentId];
  // Reactivation-only fallback: a field no setting configures keeps the child's
  // current value instead of following the parent's live model.
  const currentSettings: AgentAiSettingsLayerValues = {
    model: coerceNonEmptyString(bucket?.model) ?? coerceNonEmptyString(child.taskModelString),
    thinkingLevel:
      coerceThinkingLevel(bucket?.thinkingLevel) ?? coerceThinkingLevel(child.taskThinkingLevel),
    reasoningMode:
      bucket != null ? (coerceOpenAIReasoningMode(bucket.reasoningMode) ?? "standard") : undefined,
  };
  const pinsLayer = taskAiPinsToLayer(child.taskAiPins);
  const layers = prepared?.layers ?? null;
  const resolved = resolveNodeAgentAiSettingsWithLayers(
    {
      agentId,
      profile: "subagent",
      cfg: config,
      providersConfig: params.providersConfig,
      ...(Object.keys(pinsLayer).length > 0 ? { targetWorkspaceSettings: pinsLayer } : {}),
      parentWorkspaceExecSettings: resolveParentWorkspaceExecSettings(parent),
      fallbacks: [
        currentSettings,
        ...(parent != null ? buildParentAiSettingsFallbacks(parent, agentId) : []),
      ],
    },
    layers ?? { ancestors: [] }
  );
  if (layers == null) {
    log.debug("planReawakenAi: resolving without definition layers", {
      taskId,
      agentId,
      reason: prepared == null ? "not_prepared" : "definition_unavailable",
    });
  }

  const inputsKey = computeReawakenInputsKey(config, taskId, freshContextKey);
  assert(inputsKey != null, "planReawakenAi: inputs key requires the task entry");
  const snapshot: AgentTaskTurnAiSnapshot = {
    agentId,
    taskModelString: resolved.selected.model,
    canonicalModel: resolved.effective.model,
    thinkingLevel: resolved.effective.thinkingLevel,
    reasoningMode: resolved.selected.reasoningMode ?? "standard",
  };
  assert(snapshot.taskModelString.length > 0, "planReawakenAi: resolved model must be non-empty");
  return { kind: "resolved", snapshot, inputsKey, usedDefinitionLayers: layers != null };
}

/**
 * Writes a committed snapshot into the task entry (inside the execution-claim
 * transform): canonical aiSettings, the active-agent bucket (normalized like
 * send-time persistence), and the restart-safe task fields.
 */
export function applyAgentTaskTurnAiSnapshot(
  workspace: WorkspaceConfigEntry,
  snapshot: AgentTaskTurnAiSnapshot
): void {
  assert(snapshot.agentId.length > 0, "applyAgentTaskTurnAiSnapshot: agentId must be non-empty");
  const bucketModel = normalizeSelectedModel(snapshot.taskModelString).trim();
  assert(bucketModel.length > 0, "applyAgentTaskTurnAiSnapshot: model must be non-empty");
  workspace.aiSettings = {
    model: snapshot.canonicalModel,
    thinkingLevel: snapshot.thinkingLevel,
    reasoningMode: snapshot.reasoningMode,
  };
  workspace.aiSettingsByAgent = {
    ...(workspace.aiSettingsByAgent ?? {}),
    [snapshot.agentId]: {
      model: bucketModel,
      thinkingLevel: snapshot.thinkingLevel,
      reasoningMode: snapshot.reasoningMode,
    },
  };
  workspace.taskModelString = snapshot.taskModelString;
  workspace.taskThinkingLevel = snapshot.thinkingLevel;
}

/** Retryable refusal text shared by every "inputs changed during reawakening" outcome. */
export function formatReawakenChangedMessage(taskId: string): string {
  return `Sub-agent ${taskId} changed while it was being reawakened; send the message again.`;
}

/**
 * Thrown inside the execution-claim transform when the reawakening's inputs
 * changed after planning. Throwing aborts the whole config write: neither the
 * claim nor the AI settings are persisted.
 */
export class AgentTaskAiInputsChangedError extends Error {
  constructor(taskId: string) {
    super(formatReawakenChangedMessage(taskId));
    this.name = "AgentTaskAiInputsChangedError";
  }
}
