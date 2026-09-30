import assert from "@/common/utils/assert";

import type { AgentDefinitionFrontmatter, AgentId } from "@/common/types/agentDefinition";
import type { ProjectsConfig } from "@/common/types/project";

const ALWAYS_ENABLED_AGENT_IDS = new Set<AgentId>(["exec", "plan", "compact", "mux"]);

export function isAgentDisabledByFrontmatter(frontmatter: AgentDefinitionFrontmatter): boolean {
  assert(frontmatter, "isAgentDisabledByFrontmatter: frontmatter is required");
  return frontmatter.disabled === true;
}

export function resolveAgentEnabledOverride(
  cfg: ProjectsConfig,
  agentId: AgentId
): boolean | undefined {
  assert(cfg, "resolveAgentEnabledOverride: cfg is required");
  assert(agentId.length > 0, "resolveAgentEnabledOverride: agentId must be non-empty");

  const entry = cfg.agentAiDefaults?.[agentId];
  return typeof entry?.enabled === "boolean" ? entry.enabled : undefined;
}

export function isAgentEffectivelyDisabled(args: {
  cfg: ProjectsConfig;
  agentId: AgentId;
  resolvedFrontmatter: AgentDefinitionFrontmatter;
}): boolean {
  assert(args, "isAgentEffectivelyDisabled: args is required");
  assert(args.cfg, "isAgentEffectivelyDisabled: cfg is required");
  assert(args.agentId.length > 0, "isAgentEffectivelyDisabled: agentId must be non-empty");
  assert(args.resolvedFrontmatter, "isAgentEffectivelyDisabled: resolvedFrontmatter is required");

  // Core agents must always remain available so mux can safely fall back.
  if (ALWAYS_ENABLED_AGENT_IDS.has(args.agentId)) {
    return false;
  }

  const override = resolveAgentEnabledOverride(args.cfg, args.agentId);
  if (override === true) {
    return false;
  }
  if (override === false) {
    return true;
  }

  return isAgentDisabledByFrontmatter(args.resolvedFrontmatter);
}
