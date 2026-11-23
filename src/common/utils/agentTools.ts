import type { AgentId } from "@/common/types/agentDefinition";

export interface ToolsConfig {
  add?: readonly string[];
  remove?: readonly string[];
  require?: readonly string[];
}

export interface ToolsConfigCarrier {
  tools?: ToolsConfig;
}

function toolMatchesPatterns(toolName: string, patterns: readonly string[]): boolean {
  for (const pattern of patterns) {
    const regex = new RegExp(`^(?:${pattern})$`);
    if (regex.test(toolName)) {
      return true;
    }
  }
  return false;
}

export function normalizeLiteralRequiredToolPattern(pattern: string): string | undefined {
  const trimmed = pattern.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  // Require must target a single concrete tool name, not a regex pattern.
  if (!/^[A-Za-z0-9_:-]+$/.test(trimmed)) {
    return undefined;
  }

  return trimmed;
}

/**
 * Apply add/remove semantics to a single tool name.
 *
 * `configs` must be ordered base → child.
 *
 * Semantics:
 * - Baseline is deny-all.
 * - If a tool matches any `add` pattern it becomes enabled.
 * - If a tool matches any `remove` pattern it becomes disabled (overrides earlier adds).
 * - `require` uses last-layer-wins semantics: when present, the last non-empty
 *   require pattern from the most-derived layer determines enabled status.
 */
export function isToolEnabledByConfigs(toolName: string, configs: readonly ToolsConfig[]): boolean {
  let enabled = false;
  let effectiveRequirePattern: string | undefined;

  for (const config of configs) {
    if (config.add && toolMatchesPatterns(toolName, config.add)) {
      enabled = true;
    }

    if (config.remove && toolMatchesPatterns(toolName, config.remove)) {
      enabled = false;
    }

    if (config.require !== undefined) {
      const cleanedRequirePatterns = config.require
        .map((pattern) => normalizeLiteralRequiredToolPattern(pattern))
        .filter((pattern): pattern is string => pattern !== undefined);
      effectiveRequirePattern = cleanedRequirePatterns.at(-1);
    }
  }

  if (effectiveRequirePattern !== undefined) {
    return toolMatchesPatterns(toolName, [effectiveRequirePattern]);
  }

  return enabled;
}

/**
 * Extract tool configs from a resolved inheritance chain.
 *
 * Input order: child → base (selected agent first)
 * Output order: base → child (for correct add/remove semantics)
 */
export function collectToolConfigsFromResolvedChain(
  agents: readonly ToolsConfigCarrier[],
  maxDepth = 10
): ToolsConfig[] {
  return [...agents]
    .slice(0, maxDepth)
    .reverse()
    .filter((agent): agent is ToolsConfigCarrier & { tools: ToolsConfig } => agent.tools != null)
    .map((agent) => agent.tools);
}

export function isToolEnabledInResolvedChain(
  toolName: string,
  agents: readonly ToolsConfigCarrier[],
  maxDepth = 10
): boolean {
  return isToolEnabledByConfigs(toolName, collectToolConfigsFromResolvedChain(agents, maxDepth));
}

export function isPlanLikeInResolvedChain(
  agents: readonly ToolsConfigCarrier[],
  maxDepth = 10
): boolean {
  return isToolEnabledInResolvedChain("propose_plan", agents, maxDepth);
}

export function isExecLikeEditingCapableInResolvedChain(
  agents: ReadonlyArray<ToolsConfigCarrier & { id: AgentId }>,
  maxDepth = 10
): boolean {
  const inheritsExec = agents.some((agent) => agent.id === "exec");
  if (!inheritsExec) {
    return false;
  }

  return (
    isToolEnabledInResolvedChain("file_edit_insert", agents, maxDepth) ||
    isToolEnabledInResolvedChain("file_edit_replace_string", agents, maxDepth) ||
    // Patch-applying agents can still modify their workspace by applying child patches.
    isToolEnabledInResolvedChain("task_apply_git_patch", agents, maxDepth)
  );
}
