/**
 * Builds resolver ancestor layers child to root, from an already-gathered
 * descriptor lookup (declared bases) or an already-read inheritance chain.
 * Reads no agent files; adapters gather both from their environment. The
 * implicit plan/exec fallback is not represented here: the pure resolver
 * appends it.
 */

import type {
  AgentAiAncestorLayer,
  AgentAiDefinitionDefaults,
} from "@/common/types/agentAiSettings";

export interface AgentAncestorDescriptor {
  base?: string;
  definitionAiDefaults?: AgentAiDefinitionDefaults;
}

/** Matches MAX_INHERITANCE_DEPTH in the Node definition loader. */
export const MAX_AGENT_CHAIN_DEPTH = 10;

export function collectDeclaredAncestorLayers(
  agentId: string,
  descriptorsById: ReadonlyMap<string, AgentAncestorDescriptor>
): AgentAiAncestorLayer[] {
  const visited = new Set<string>([agentId]);
  const ancestors: AgentAiAncestorLayer[] = [];
  let cursor = agentId;

  while (ancestors.length < MAX_AGENT_CHAIN_DEPTH) {
    const base = descriptorsById.get(cursor)?.base;
    // Same-id bases (e.g. project exec.md with base: exec) refine the
    // definition, not the config chain; cycles end traversal.
    if (base == null || base === cursor || visited.has(base)) break;
    visited.add(base);
    const definitionAiDefaults = descriptorsById.get(base)?.definitionAiDefaults;
    ancestors.push({ agentId: base, ...(definitionAiDefaults ? { definitionAiDefaults } : {}) });
    cursor = base;
  }

  return ancestors;
}

function toDefinitionDefaults(
  ai: AgentAiDefinitionDefaults | undefined
): AgentAiDefinitionDefaults | undefined {
  if (
    !ai ||
    (ai.model === undefined && ai.thinkingLevel === undefined && ai.cacheTtl === undefined)
  ) {
    return undefined;
  }
  return { model: ai.model, thinkingLevel: ai.thinkingLevel, cacheTtl: ai.cacheTtl };
}

/** Field-wise merge of definition layers; the closer scope/hop wins per field. */
function mergeDefinitionDefaults(
  closer: AgentAiDefinitionDefaults | undefined,
  further: AgentAiDefinitionDefaults | undefined
): AgentAiDefinitionDefaults | undefined {
  if (!closer) return further;
  if (!further) return closer;
  return {
    model: closer.model ?? further.model,
    thinkingLevel: closer.thinkingLevel ?? further.thinkingLevel,
    cacheTtl: closer.cacheTtl ?? further.cacheTtl,
  };
}

/**
 * Map an inheritance chain (target first, as returned by
 * resolveAgentInheritanceChain) onto resolver layers. Consecutive entries with
 * the same agent ID are scope refinements (e.g. project `exec.md` with
 * `base: exec` refining the global/built-in `exec`) and merge field-wise into
 * one layer, closer first. An ID that comes back after a different agent (a
 * global agent's base skips the project agent of that ID) is a further hop and
 * keeps its own, later layer.
 */
export function collectDefinitionLayers(
  agentId: string,
  chain: ReadonlyArray<{ id: string; ai?: AgentAiDefinitionDefaults }>
): {
  targetDefinitionAiDefaults?: AgentAiDefinitionDefaults;
  ancestors: AgentAiAncestorLayer[];
} {
  const targetId = chain[0]?.id ?? agentId;
  let targetDefinitionAiDefaults = toDefinitionDefaults(chain[0]?.ai);
  const ancestors: AgentAiAncestorLayer[] = [];
  for (const entry of chain.slice(1)) {
    const defaults = toDefinitionDefaults(entry.ai);
    const previous = ancestors.at(-1);
    if (!previous && (entry.id === targetId || entry.id === agentId)) {
      targetDefinitionAiDefaults = mergeDefinitionDefaults(targetDefinitionAiDefaults, defaults);
    } else if (previous?.agentId === entry.id) {
      previous.definitionAiDefaults = mergeDefinitionDefaults(
        previous.definitionAiDefaults,
        defaults
      );
    } else {
      ancestors.push({ agentId: entry.id, definitionAiDefaults: defaults });
    }
  }
  return { targetDefinitionAiDefaults, ancestors };
}
