import type { AgentAiDefaults } from "@/common/types/agentAiDefaults";
import { isBuiltInSelectableAgentId } from "@/browser/utils/agents";
import type { AgentDefinitionDescriptor } from "@/common/types/agentDefinition";
import { targetWorkspaceBucketToLayer, type AiSettingSource } from "@/common/types/agentAiSettings";
import {
  coerceOpenAIReasoningMode,
  coerceThinkingLevel,
  type OpenAIReasoningMode,
  type ThinkingLevel,
} from "@/common/types/thinking";
import { normalizeAgentId as normalizeWorkspaceAgentId } from "@/common/utils/agentIds";
import {
  collectDeclaredAncestorLayers,
  type AgentAncestorDescriptor,
} from "@/common/utils/ai/agentAncestorLayers";
import { resolveAgentAiSettings } from "@/common/utils/ai/resolveAgentAiSettings";

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
): { modelString?: string; thinkingLevel?: ThinkingLevel; reasoningMode?: OpenAIReasoningMode } {
  const normalizedAgentId = normalizeAgentId(agentId);
  const descriptorsById = new Map([...(agentBaseById ?? [])].map(([id, base]) => [id, { base }]));
  const resolved = resolveAgentAiSettings({
    targetAgentId: normalizedAgentId,
    profile: "interactive",
    agentAiDefaults,
    ancestors: collectDeclaredAncestorLayers(normalizedAgentId, descriptorsById),
  });
  const fromConfig = (source: AiSettingSource | undefined) => source?.tier === "config";
  return {
    modelString: fromConfig(resolved.sources.model) ? resolved.selected.model : undefined,
    thinkingLevel: fromConfig(resolved.sources.thinkingLevel)
      ? resolved.selected.thinkingLevel
      : undefined,
    reasoningMode: fromConfig(resolved.sources.reasoningMode)
      ? resolved.selected.reasoningMode
      : undefined,
  };
}

type WorkspaceAiResolutionMode = "explicit-switch" | "background-sync" | "creation-sync";

type WorkspaceAgentDescriptor = Pick<
  AgentDefinitionDescriptor,
  "id" | "base" | "ownAiDefaults" | "aiAncestors"
>;

interface WorkspaceAiResolutionArgs {
  agentId: string;
  agentAiDefaults: AgentAiDefaults;
  workspaceByAgent?: WorkspaceAISettingsCache;
  fallbackModel: string;
  existingModel: string;
  existingThinking: ThinkingLevel;
  existingReasoningMode?: OpenAIReasoningMode;
  agents?: readonly WorkspaceAgentDescriptor[];
  /** Compatibility inputs for pure resolver tests and non-UI adapters. */
  useWorkspaceByAgentFallback?: boolean;
  agentBaseById?: ReadonlyMap<string, string | undefined>;
  agentDescriptorById?: ReadonlyMap<string, AgentAncestorDescriptor>;
  mode?: WorkspaceAiResolutionMode;
}

interface ResolvedWorkspaceAiSettings {
  resolvedModel: string;
  resolvedThinking: ThinkingLevel;
  resolvedReasoningMode: OpenAIReasoningMode;
}

function buildAgentDescriptorLookup(
  args: WorkspaceAiResolutionArgs,
  includeDefinitionDefaults: boolean
): Map<string, AgentAncestorDescriptor> {
  const descriptors = new Map<string, AgentAncestorDescriptor>();
  for (const agent of args.agents ?? []) {
    descriptors.set(agent.id, {
      base: agent.base,
      ...(includeDefinitionDefaults && agent.ownAiDefaults
        ? { definitionAiDefaults: agent.ownAiDefaults }
        : {}),
    });
  }
  for (const [id, descriptor] of args.agentDescriptorById ?? []) {
    descriptors.set(id, {
      base: descriptor.base,
      ...(includeDefinitionDefaults && descriptor.definitionAiDefaults
        ? { definitionAiDefaults: descriptor.definitionAiDefaults }
        : {}),
    });
  }
  for (const [id, base] of args.agentBaseById ?? []) {
    descriptors.set(id, { ...descriptors.get(id), base });
  }
  return descriptors;
}

export function hasWorkspaceAiTargetDescriptor(
  agentId: string,
  agents: readonly WorkspaceAgentDescriptor[]
): boolean {
  const normalizedAgentId = normalizeAgentId(agentId);
  return agents.some((agent) => normalizeAgentId(agent.id) === normalizedAgentId);
}

interface CreationWorkspaceAiSyncState {
  isExplicitAgentSwitch: boolean;
  mode: "creation-sync" | "background-sync";
}

export function getCreationWorkspaceAiSyncState(args: {
  previousAgentId: string | null;
  previousScopeId: string | null;
  agentId: string;
  scopeId: string;
}): CreationWorkspaceAiSyncState {
  const hasPriorSelection = args.previousAgentId !== null && args.previousScopeId === args.scopeId;
  const isExplicitAgentSwitch = hasPriorSelection && args.previousAgentId !== args.agentId;

  return {
    isExplicitAgentSwitch,
    // Definition defaults seed the initial selection and explicit switches only.
    // Later descriptor arrival must preserve any model the user already selected.
    mode: !hasPriorSelection || isExplicitAgentSwitch ? "creation-sync" : "background-sync",
  };
}

// Keep agent -> model/thinking precedence in one place so explicit switches,
// background sync, and workspace creation agree on descriptor availability.
export function resolveWorkspaceAiSettingsForAgent(
  args: WorkspaceAiResolutionArgs & { mode: "explicit-switch" }
): ResolvedWorkspaceAiSettings | null;
export function resolveWorkspaceAiSettingsForAgent(
  args: WorkspaceAiResolutionArgs & { mode?: "background-sync" | "creation-sync" }
): ResolvedWorkspaceAiSettings;
export function resolveWorkspaceAiSettingsForAgent(
  args: WorkspaceAiResolutionArgs
): ResolvedWorkspaceAiSettings;
export function resolveWorkspaceAiSettingsForAgent(
  args: WorkspaceAiResolutionArgs
): ResolvedWorkspaceAiSettings | null {
  const normalizedAgentId = normalizeAgentId(args.agentId);
  const mode =
    args.mode ??
    (args.useWorkspaceByAgentFallback === true
      ? "explicit-switch"
      : args.useWorkspaceByAgentFallback === false
        ? "background-sync"
        : "creation-sync");
  if (
    mode === "explicit-switch" &&
    args.agents != null &&
    !hasWorkspaceAiTargetDescriptor(normalizedAgentId, args.agents) &&
    !isBuiltInSelectableAgentId(normalizedAgentId)
  ) {
    return null;
  }

  const workspaceOverride = args.workspaceByAgent?.[normalizedAgentId];
  const includeDefinitionDefaults = mode !== "background-sync";
  const descriptorsById = buildAgentDescriptorLookup(args, includeDefinitionDefaults);
  const targetDescriptor = args.agents?.find(
    (agent) => normalizeAgentId(agent.id) === normalizedAgentId
  );
  const ancestors =
    includeDefinitionDefaults && targetDescriptor?.aiAncestors
      ? targetDescriptor.aiAncestors
      : collectDeclaredAncestorLayers(normalizedAgentId, descriptorsById);
  const resolved = resolveAgentAiSettings({
    targetAgentId: normalizedAgentId,
    profile: "interactive",
    targetWorkspaceSettings:
      mode !== "creation-sync" && workspaceOverride != null
        ? targetWorkspaceBucketToLayer(workspaceOverride)
        : undefined,
    agentAiDefaults: args.agentAiDefaults,
    targetDefinitionAiDefaults: descriptorsById.get(normalizedAgentId)?.definitionAiDefaults,
    ancestors,
    parentRuntime: {
      model: typeof args.existingModel === "string" ? args.existingModel : undefined,
      thinkingLevel: coerceThinkingLevel(args.existingThinking),
      reasoningMode: coerceOpenAIReasoningMode(args.existingReasoningMode),
    },
    defaultModel: args.fallbackModel,
  });

  const resolvedReasoningMode = resolved.selected.reasoningMode ?? "standard";

  return {
    resolvedModel: resolved.selected.model,
    resolvedThinking: resolved.selected.thinkingLevel,
    resolvedReasoningMode,
  };
}
