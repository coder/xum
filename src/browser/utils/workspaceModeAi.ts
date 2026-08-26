import type { AgentAiDefaults } from "@/common/types/agentAiDefaults";
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
  agentDescriptorById?: ReadonlyMap<string, AgentAncestorDescriptor>;
}): {
  resolvedModel: string;
  resolvedThinking: ThinkingLevel;
  resolvedReasoningMode: OpenAIReasoningMode;
} {
  const normalizedAgentId = normalizeAgentId(args.agentId);
  const workspaceOverride = args.workspaceByAgent?.[normalizedAgentId];
  const descriptorsById = new Map(args.agentDescriptorById ?? []);
  for (const [id, base] of args.agentBaseById ?? []) {
    descriptorsById.set(id, { ...descriptorsById.get(id), base });
  }
  const resolved = resolveAgentAiSettings({
    targetAgentId: normalizedAgentId,
    profile: "interactive",
    targetWorkspaceSettings:
      args.useWorkspaceByAgentFallback && workspaceOverride != null
        ? targetWorkspaceBucketToLayer(workspaceOverride)
        : undefined,
    agentAiDefaults: args.agentAiDefaults,
    targetDefinitionAiDefaults: descriptorsById.get(normalizedAgentId)?.definitionAiDefaults,
    ancestors: collectDeclaredAncestorLayers(normalizedAgentId, descriptorsById),
    parentRuntime: {
      model: typeof args.existingModel === "string" ? args.existingModel : undefined,
      thinkingLevel: coerceThinkingLevel(args.existingThinking),
      reasoningMode: coerceOpenAIReasoningMode(args.existingReasoningMode),
    },
    defaultModel: args.fallbackModel,
  });

  // Background sync trusts the live workspace mode, which hydration seeds from
  // the backend bucket, instead of restoring the saved bucket or configured mode.
  const resolvedReasoningMode =
    workspaceOverride != null && !args.useWorkspaceByAgentFallback
      ? (coerceOpenAIReasoningMode(args.existingReasoningMode) ?? "standard")
      : (resolved.selected.reasoningMode ?? "standard");

  return {
    resolvedModel: resolved.selected.model,
    resolvedThinking: resolved.selected.thinkingLevel,
    resolvedReasoningMode,
  };
}
