import type { AgentDefinitionFrontmatter } from "@/common/types/agentDefinition";

/**
 * Resolved visibility for an agent.
 *
 * - `selectable` controls whether the agent appears in the human picker, the
 *   ACP `agentMode` option list, and `agents.list` (subject to capability gating).
 *
 * This is the single source of truth for the rule; do not re-implement it
 * inline. Use {@link resolveAgentVisibility} everywhere this boolean is needed.
 */
export interface AgentVisibility {
  selectable: boolean;
}

export function resolveAgentVisibility(
  ui: AgentDefinitionFrontmatter["ui"] | undefined
): AgentVisibility {
  return { selectable: ui?.hidden !== true };
}
