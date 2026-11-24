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
import assert from "@/common/utils/assert";

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

/** AI-settings walks follow this in place of `base` (Cursor plugin RFC, D11). */
export function aiSettingsBaseOf(agent: { base?: string; aiSettingsBase?: string }) {
  return agent.aiSettingsBase ?? agent.base;
}

export interface ListedAgentAiAncestry {
  id: string;
  base?: string;
  aiSettingsBase?: string;
  aiLayers?: { ancestors: readonly AgentAiAncestorLayer[] };
}

/**
 * The hops of the listed agents' resolved ancestry through agents the list leaves out, such as a
 * disabled Explore that a `fast` agent's settings base names: without them a declared-base walk
 * stops at the unlisted agent, while a run goes on to its bases.
 */
export function collectUnlistedAncestorHops(
  agents: readonly ListedAgentAiAncestry[]
): Map<string, AgentAncestorDescriptor> {
  const listed = new Set(agents.map((agent) => agent.id));
  const hops = new Map<string, AgentAncestorDescriptor>();
  for (const agent of agents) {
    const ancestors = agent.aiLayers?.ancestors ?? [];
    ancestors.forEach((layer, index) => {
      if (listed.has(layer.agentId) || hops.has(layer.agentId)) return;
      hops.set(layer.agentId, {
        base: ancestors[index + 1]?.agentId,
        definitionAiDefaults: layer.definitionAiDefaults,
      });
    });
  }
  return hops;
}

export function getAgentAiSettingsBases(
  agents: readonly ListedAgentAiAncestry[]
): Map<string, string | undefined> {
  return new Map([
    ...[...collectUnlistedAncestorHops(agents)].map(([id, hop]) => [id, hop.base] as const),
    ...agents.map((agent) => [agent.id, aiSettingsBaseOf(agent)] as const),
  ]);
}

/** The hop whose `ai.settingsBase` applies: the closest, as in the base-merged frontmatter. */
export function settingsBaseHop<T extends { ai?: { settingsBase?: string } }>(
  chain: readonly T[]
): T | undefined {
  return chain.find((entry) => entry.ai?.settingsBase != null);
}

/** A read chain that stops at a missing or cyclic base: agents.list cannot resolve it. */
function isIncompleteChain(chain: ReadonlyArray<{ base?: string }>): boolean {
  return chain.at(-1)?.base != null;
}

export type SettingsBaseIgnoredReason = "missing" | "incomplete" | "self" | "cycle" | "nested";

interface SettingsBaseChainHop {
  id: string;
  base?: string;
  ai?: { settingsBase?: string };
}

function settingsBaseIgnoredReason(
  agentId: string,
  ownChain: readonly SettingsBaseChainHop[],
  settingsBaseChain: readonly SettingsBaseChainHop[] | null
): SettingsBaseIgnoredReason | undefined {
  // Decided by ID: a same-ID read skips the agent's own scope, as a same-ID `base` does.
  if (settingsBaseHop(ownChain)?.ai?.settingsBase === agentId) return "self";
  if (settingsBaseChain === null) return "missing";
  if ([ownChain, settingsBaseChain].some(isIncompleteChain)) return "incomplete";
  if (settingsBaseChain.some((entry) => entry.id === agentId)) return "cycle";
  return settingsBaseHop(settingsBaseChain) != null ? "nested" : undefined;
}

/**
 * The AI-settings chain of an agent with `ai.settingsBase` (Cursor plugin RFC, D11, D26): the
 * agent's own entries (its same-ID scope refinements), then the settings-base agent's chain in
 * place of the agent's own bases. Both chains are target first. `settingsBaseChain` is null
 * when the settings-base agent could not be read. A settings base is ignored when it is
 * missing, when either chain stops at a missing or cyclic base, when it is the agent itself or
 * inherits from it, and when its chain sets `ai.settingsBase` again (nested): the own chain
 * comes back with the reason, so every consumer falls back to `base`.
 */
export function applySettingsBaseChain<T extends SettingsBaseChainHop>(
  agentId: string,
  ownChain: readonly T[],
  settingsBaseChain: readonly T[] | null
): { chain: T[]; ignored?: SettingsBaseIgnoredReason } {
  const ignored = settingsBaseIgnoredReason(agentId, ownChain, settingsBaseChain);
  if (ignored != null || settingsBaseChain === null) return { chain: [...ownChain], ignored };
  assert(settingsBaseChain.length > 0, "applySettingsBaseChain: a read chain starts at its agent");
  const firstBase = ownChain.findIndex((entry) => entry.id !== agentId);
  const ownEntries = firstBase === -1 ? ownChain : ownChain.slice(0, firstBase);
  return { chain: [...ownEntries, ...settingsBaseChain] };
}
