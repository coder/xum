import type { AgentAiDefaults } from "@/common/types/agentAiDefaults";
import { isValidModelFormat } from "@/common/utils/ai/models";
import type { AiSettingSource } from "@/common/types/agentAiSettings";
import {
  coerceOpenAIReasoningMode,
  coerceThinkingLevel,
  type OpenAIReasoningMode,
  type ThinkingLevel,
} from "@/common/types/thinking";
import { normalizeAgentId as normalizeWorkspaceAgentId } from "@/common/utils/agentIds";
import { collectDeclaredAncestorLayers } from "@/common/utils/ai/agentAncestorLayers";
import { resolveAgentAiSettings } from "@/common/utils/ai/resolveAgentAiSettings";
import type { AutoRoutingDimension } from "@/browser/utils/modelChange";

export type WorkspaceAISettingsCache = Partial<
  Record<
    string,
    { model: string; thinkingLevel: ThinkingLevel; reasoningMode?: OpenAIReasoningMode }
  >
>;

function normalizeAgentId(agentId: string): string {
  return normalizeWorkspaceAgentId(agentId, "exec");
}

/**
 * Field-wise configured defaults for an agent through its declared base chain,
 * delegating precedence to the shared resolver. Values are "configured" only
 * when the resolver sourced them from a config tier, so system defaults and
 * the resolver's built-in fallbacks never masquerade as configured values.
 * Custom agents (base: exec) inherit an ancestor's model/thinking/pro defaults
 * together (persisting an inherited pro without its pro-capable model would
 * let request gating drop it), while the implicit fallback for unknown agents
 * contributes reasoningMode alone, so desktop mode switches to unconfigured
 * agents keep the workspace's current model instead of yanking it to exec's
 * configured default.
 */
export function resolveConfiguredAiDefaults(
  agentId: string,
  agentAiDefaults: AgentAiDefaults,
  agentBaseById?: ReadonlyMap<string, string | undefined>
): {
  modelString?: string;
  thinkingLevel?: ThinkingLevel;
  reasoningMode?: OpenAIReasoningMode;
  /** Present only when the nearest config layer deciding the dimension chose Auto. */
  autoModelRouting?: true;
  autoThinkingLevel?: true;
} {
  const normalizedAgentId = normalizeAgentId(agentId);
  const descriptorsById = new Map([...(agentBaseById ?? [])].map(([id, base]) => [id, { base }]));
  const ancestors = collectDeclaredAncestorLayers(normalizedAgentId, descriptorsById);
  const resolved = resolveAgentAiSettings({
    targetAgentId: normalizedAgentId,
    profile: "interactive",
    agentAiDefaults,
    ancestors,
  });
  const fromConfig = (source: AiSettingSource | undefined) => source?.tier === "config";

  // Auto is decided by the closest declared layer that sets either the Auto
  // flag or a concrete value for the dimension, so a child's concrete pick
  // blocks an ancestor's Auto. The implicit exec fallback is not in the chain:
  // it contributes reasoningMode only.
  const chainIds = [normalizedAgentId, ...ancestors.map((ancestor) => ancestor.agentId)];
  const resolveConfiguredAuto = (
    flag: "autoModelRouting" | "autoThinkingLevel",
    source: AiSettingSource | undefined
  ): true | undefined => {
    for (const id of chainIds) {
      if (agentAiDefaults[id]?.[flag] === true) return true;
      if (fromConfig(source) && source?.agentId === id) return undefined;
    }
    return undefined;
  };
  const autoModelRouting = resolveConfiguredAuto("autoModelRouting", resolved.sources.model);
  const autoThinkingLevel = resolveConfiguredAuto(
    "autoThinkingLevel",
    resolved.sources.thinkingLevel
  );

  return {
    modelString: fromConfig(resolved.sources.model) ? resolved.selected.model : undefined,
    thinkingLevel: fromConfig(resolved.sources.thinkingLevel)
      ? resolved.selected.thinkingLevel
      : undefined,
    reasoningMode: fromConfig(resolved.sources.reasoningMode)
      ? resolved.selected.reasoningMode
      : undefined,
    ...(autoModelRouting ? { autoModelRouting } : {}),
    ...(autoThinkingLevel ? { autoThinkingLevel } : {}),
  };
}

/** Browser-local per-agent record of explicit composer routing picks (true = Auto, false = concrete). */
export type AutoRoutingChoiceByAgent = Partial<
  Record<string, Partial<Record<AutoRoutingDimension, boolean>>>
>;

/** Per dimension: true/false sets the scope's Auto flag; undefined leaves it unchanged. */
export type AutoRoutingOutcome = Record<AutoRoutingDimension, boolean | undefined>;

/**
 * Auto routing state an agent resolution applies to a composer scope.
 * Precedence per dimension: the workspace's explicit routing pick for the agent,
 * then the configured default. Explicit agent switches always settle the flag;
 * background sync only turns Auto on for a configured default the workspace has
 * no pick or per-agent bucket value for (the same condition under which a
 * configured concrete value applies), and never turns it off so a user's Auto
 * survives Settings edits.
 */
export function resolveAutoRoutingForAgent(args: {
  agentId: string;
  agentAiDefaults: AgentAiDefaults;
  agentBaseById?: ReadonlyMap<string, string | undefined>;
  explicitSwitch: boolean;
  experimentEnabled: boolean;
  routingChoices?: AutoRoutingChoiceByAgent;
  workspaceByAgent?: WorkspaceAISettingsCache;
}): AutoRoutingOutcome {
  if (!args.experimentEnabled) {
    // Saved routing preferences stay stored but inert while the experiment is off.
    const outcome = args.explicitSwitch ? false : undefined;
    return { model: outcome, thinkingLevel: outcome };
  }

  const normalizedAgentId = normalizeAgentId(args.agentId);
  const configured = resolveConfiguredAiDefaults(
    normalizedAgentId,
    args.agentAiDefaults,
    args.agentBaseById
  );
  const choices = args.routingChoices?.[normalizedAgentId];
  const bucket = args.workspaceByAgent?.[normalizedAgentId];
  const bucketModel = typeof bucket?.model === "string" ? bucket.model.trim() : "";
  const hasBucketValue: Record<AutoRoutingDimension, boolean> = {
    model: isValidModelFormat(bucketModel),
    thinkingLevel: coerceThinkingLevel(bucket?.thinkingLevel) != null,
  };
  const configuredAuto: Record<AutoRoutingDimension, boolean> = {
    model: configured.autoModelRouting === true,
    thinkingLevel: configured.autoThinkingLevel === true,
  };

  const resolveDimension = (dimension: AutoRoutingDimension): boolean | undefined => {
    const choice = choices?.[dimension];
    if (args.explicitSwitch) {
      return choice ?? configuredAuto[dimension];
    }
    return configuredAuto[dimension] && choice === undefined && !hasBucketValue[dimension]
      ? true
      : undefined;
  };

  return { model: resolveDimension("model"), thinkingLevel: resolveDimension("thinkingLevel") };
}

// Keep agent -> model/thinking precedence in one place so mode switches that send immediately
// (like propose_plan Implement / Continue in Auto) resolve the same settings as sync effects.
export function resolveWorkspaceAiSettingsForAgent(args: {
  agentId: string;
  agentAiDefaults: AgentAiDefaults;
  workspaceByAgent?: WorkspaceAISettingsCache;
  useWorkspaceByAgentFallback?: boolean;
  fallbackModel: string;
  existingModel: string;
  existingThinking: ThinkingLevel;
  existingReasoningMode?: OpenAIReasoningMode;
  /** Agent id -> base id, for base-chain reasoning-mode inheritance (custom agents). */
  agentBaseById?: ReadonlyMap<string, string | undefined>;
}): {
  resolvedModel: string;
  resolvedThinking: ThinkingLevel;
  resolvedReasoningMode: OpenAIReasoningMode;
} {
  const normalizedAgentId = normalizeAgentId(args.agentId);
  const workspaceOverride = args.workspaceByAgent?.[normalizedAgentId];

  // Field-wise across the agent's own entry then its base chain: an agent
  // inheriting GPT-5.6 + pro from its base must resolve both together even
  // when the active workspace runs a different provider's model.
  const configuredDefaults = resolveConfiguredAiDefaults(
    normalizedAgentId,
    args.agentAiDefaults,
    args.agentBaseById
  );
  const cachedModel =
    typeof workspaceOverride?.model === "string" ? workspaceOverride.model.trim() : "";
  const workspaceModel = isValidModelFormat(cachedModel) ? cachedModel : undefined;
  const configuredModel = workspaceModel ? undefined : configuredDefaults.modelString;
  const workspaceOverrideModel = args.useWorkspaceByAgentFallback ? workspaceModel : undefined;
  const inheritedModelCandidate =
    workspaceOverrideModel ??
    (typeof args.existingModel === "string" ? args.existingModel : undefined) ??
    "";
  const inheritedModel = inheritedModelCandidate.trim();
  const resolvedModel =
    configuredModel && configuredModel.length > 0
      ? configuredModel
      : inheritedModel.length > 0
        ? inheritedModel
        : args.fallbackModel;

  // Persisted workspace settings can be stale/corrupt; re-validate inherited values
  // so mode sync keeps self-healing behavior instead of propagating invalid options.
  const workspaceThinking = coerceThinkingLevel(workspaceOverride?.thinkingLevel);
  const workspaceOverrideThinking = args.useWorkspaceByAgentFallback
    ? workspaceThinking
    : undefined;
  const inheritedThinking = workspaceOverrideThinking ?? coerceThinkingLevel(args.existingThinking);
  const resolvedThinking =
    (workspaceThinking != null ? undefined : configuredDefaults.thinkingLevel) ??
    inheritedThinking ??
    "off";

  // An existing per-agent bucket owns the reasoning choice outright (matching
  // targetWorkspaceBucketToLayer): a configured Pro default must not re-inject
  // itself over a workspace deliberately toggled to Standard (every composer
  // change rewrites the bucket, so its presence marks a workspace-level pick).
  // Explicit switches restore the bucket's saved mode; background sync trusts
  // the live workspace mode, which hydration seeds from the backend bucket.
  // Absent reasoningMode on an existing entry (legacy entry saved before pro
  // mode shipped) means "standard", matching the WorkspaceContext seeding
  // semantics, instead of inheriting a possibly-pro workspace mode from the
  // previously active agent.
  // Without a bucket entry, configured defaults (and the base chain) apply,
  // matching ACP resolution and the Settings card display, else the
  // workspace's current mode carries over.
  const resolvedReasoningMode =
    workspaceOverride != null
      ? args.useWorkspaceByAgentFallback
        ? (coerceOpenAIReasoningMode(workspaceOverride.reasoningMode) ?? "standard")
        : (coerceOpenAIReasoningMode(args.existingReasoningMode) ?? "standard")
      : (configuredDefaults.reasoningMode ??
        coerceOpenAIReasoningMode(args.existingReasoningMode) ??
        "standard");

  return { resolvedModel, resolvedThinking, resolvedReasoningMode };
}
