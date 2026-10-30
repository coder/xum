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
 * resolveAgentInheritanceChain) onto resolver layers. The chain may contain
 * multiple entries with the same agent ID distinguished by scope (e.g.
 * project `exec.md` with `base: exec` refining the global/built-in `exec`);
 * the shared resolver deduplicates ancestors by ID, so same-ID entries must
 * merge field-wise into one layer here instead of being dropped.
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
  const ancestorsById = new Map<string, AgentAiAncestorLayer>();
  for (const entry of chain.slice(1)) {
    const defaults = toDefinitionDefaults(entry.ai);
    if (entry.id === targetId || entry.id === agentId) {
      targetDefinitionAiDefaults = mergeDefinitionDefaults(targetDefinitionAiDefaults, defaults);
      continue;
    }
    const existing = ancestorsById.get(entry.id);
    if (existing) {
      existing.definitionAiDefaults = mergeDefinitionDefaults(
        existing.definitionAiDefaults,
        defaults
      );
    } else {
      ancestorsById.set(entry.id, { agentId: entry.id, definitionAiDefaults: defaults });
    }
  }
  return { targetDefinitionAiDefaults, ancestors: [...ancestorsById.values()] };
}
