import { snapshotPendingAiSelection } from "@/browser/utils/aiSelectionIntent";
import type { AgentDefinitionDescriptor } from "@/common/types/agentDefinition";
import { readScopedAiDefault, writeScopedAiDefault } from "@/browser/utils/scopedAiDefaults";
import { RUNTIME_MODE, type ParsedRuntime } from "@/common/types/runtime";
import { SCRATCH_PROJECT_CONFIG_KEY } from "@/common/constants/scratch";
import { getProjectScopeId } from "@/common/constants/storage";

type CarriedAiField = Parameters<typeof readScopedAiDefault>[1];

function carryScopedAiDefault<F extends CarriedAiField>(
  sourceScopeId: string,
  destScopeId: string,
  field: F
): void {
  // An unset source field shows the global default there, so it clears the destination's.
  const value = readScopedAiDefault(sourceScopeId, field);
  if (value !== readScopedAiDefault(destScopeId, field)) {
    writeScopedAiDefault(destScopeId, field, value);
  }
}

/** The agent a creation composer shows (undefined while its agents load). */
export type CreationDraftAgent = Pick<AgentDefinitionDescriptor, "id" | "scope">;

export interface CreationAiSettingsCarry {
  sourceProjectPath: string;
  destProjectPath: string;
  /** The source composer's agent. */
  agent: CreationDraftAgent | undefined;
  /** The ids of the destination's agents (see needsDestinationAgentIds), or null if not loaded. */
  destAgentIds: readonly string[] | null;
}

/**
 * Moving a creation draft to another project (the creation header's project selector) carries
 * the settings its composer shows. Creation AI settings are project-scoped defaults, so the
 * destination project's defaults take the source's values, as if the user had picked them there.
 * Not setWorkspaceModelWithOrigin: its "user" origin would turn Auto off.
 */
export function carryCreationAiSettings(carry: CreationAiSettingsCarry): void {
  if (carry.sourceProjectPath === carry.destProjectPath) return;
  const sourceScopeId = getProjectScopeId(carry.sourceProjectPath);
  const destScopeId = getProjectScopeId(carry.destProjectPath);
  for (const field of ["model", "thinkingLevel"] as const) {
    carryScopedAiDefault(sourceScopeId, destScopeId, field);
  }
  // Unsent picks (reasoning mode, service tier, Auto routing) replace the destination's own.
  snapshotPendingAiSelection(sourceScopeId)(destScopeId);
  const agentMove = planAgentMove(sourceScopeId, destScopeId, carry.agent);
  if (agentMove == null) return;
  // An agent the destination lacks stays behind, and the destination keeps its own: its composer
  // would show the missing agent while a send ran the default one.
  if (agentMove.check && carry.destAgentIds?.includes(agentMove.agentId) !== true) return;
  writeScopedAiDefault(destScopeId, "agentId", agentMove.agentId);
}

/**
 * Whether moving the draft's agent needs the destination's agent list, loaded fresh: the one a
 * composer loaded earlier can be stale, and it is missing for a project whose composer was not
 * opened. The move loads it before the destination opens, so a send there has the moved agent.
 */
export function needsDestinationAgentIds(
  sourceProjectPath: string,
  destProjectPath: string,
  agent: CreationDraftAgent | undefined
): boolean {
  if (sourceProjectPath === destProjectPath) return false;
  const sourceScopeId = getProjectScopeId(sourceProjectPath);
  return planAgentMove(sourceScopeId, getProjectScopeId(destProjectPath), agent)?.check === true;
}

/**
 * The source's agent for the destination, or null when the destination already shows it.
 * Unset, the source shows the global default agent, so it clears the destination's. Built-in and
 * global agents exist in every project. Any other agent (a project's own, or one the source
 * composer has not loaded yet) is checked against the destination's agent list.
 */
function planAgentMove(
  sourceScopeId: string,
  destScopeId: string,
  agent: CreationDraftAgent | undefined
): { check: false; agentId: string | undefined } | { check: true; agentId: string } | null {
  const agentId = readScopedAiDefault(sourceScopeId, "agentId");
  if (agentId === readScopedAiDefault(destScopeId, "agentId")) return null;
  if (agentId == null || (agent?.id === agentId && agent.scope !== "project")) {
    return { check: false, agentId };
  }
  return { check: true, agentId };
}

/**
 * A runtime the user picked in a creation composer, handed to the composer that opens the moved
 * draft (keyed by its draft storage scope). The pick is component state that the remount drops.
 */
const runtimeHandOffs = new Map<string, ParsedRuntime>();

/**
 * SECURITY AUDIT: a move hands off only a runtime that keeps the destination's source on this
 * machine. An SSH host (Coder included) or a container picked for one project would otherwise
 * receive another project's source, or the user's shared credentials, without the user picking
 * it for that project. Such a pick stays behind, and the destination shows its own runtime.
 */
const HANDED_OFF_RUNTIME_MODES: ReadonlySet<ParsedRuntime["mode"]> = new Set([
  RUNTIME_MODE.LOCAL,
  RUNTIME_MODE.WORKTREE,
]);

/** Only between projects (Scratch has no runtime), and only a local runtime (see above). */
export function handOffCreationRuntime(handOff: {
  sourceProjectPath: string;
  destProjectPath: string;
  draftScopeId: string;
  runtime: ParsedRuntime | null;
}): void {
  const scopes = [handOff.sourceProjectPath, handOff.destProjectPath];
  if (handOff.runtime == null || scopes.includes(SCRATCH_PROJECT_CONFIG_KEY)) return;
  if (!HANDED_OFF_RUNTIME_MODES.has(handOff.runtime.mode)) return;
  runtimeHandOffs.set(handOff.draftScopeId, handOff.runtime);
}

/** Read without consuming: StrictMode runs state initializers twice. */
export function peekCreationRuntimeHandOff(
  draftScopeId: string | null | undefined
): ParsedRuntime | null {
  return draftScopeId != null ? (runtimeHandOffs.get(draftScopeId) ?? null) : null;
}

export function clearCreationRuntimeHandOff(draftScopeId: string | null | undefined): void {
  if (draftScopeId != null) runtimeHandOffs.delete(draftScopeId);
}
