import type { AgentDefinitionDescriptor } from "@/common/types/agentDefinition";

// Built-in agents in stable order (determines Ctrl+1, Ctrl+2, etc.)
// Only includes agents that are uiSelectable by default.
const BUILTIN_AGENT_ORDER: readonly string[] = ["exec", "plan"];

/**
 * Sort agents with stable ordering: built-ins first (exec, plan),
 * then custom agents alphabetically by name.
 */
export function sortAgentsStable<T extends Pick<AgentDefinitionDescriptor, "id" | "name">>(
  agents: T[]
): T[] {
  return [...agents].sort((a, b) => {
    const aIndex = BUILTIN_AGENT_ORDER.indexOf(a.id);
    const bIndex = BUILTIN_AGENT_ORDER.indexOf(b.id);
    const aIsBuiltin = aIndex !== -1;
    const bIsBuiltin = bIndex !== -1;

    if (aIsBuiltin && bIsBuiltin) return aIndex - bIndex;
    if (aIsBuiltin) return -1;
    if (bIsBuiltin) return 1;
    return a.name.localeCompare(b.name);
  });
}
