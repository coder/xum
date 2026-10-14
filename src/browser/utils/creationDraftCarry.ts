import { snapshotPendingAiSelection } from "@/browser/utils/aiSelectionIntent";
import type { AgentDefinitionDescriptor } from "@/common/types/agentDefinition";
import { readScopedAiDefault, writeScopedAiDefault } from "@/browser/utils/scopedAiDefaults";
import { UI_MODE_VALUES } from "@/common/types/mode";
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
  // An agent the destination may lack stays behind, and the destination keeps its own: its
  // composer would show the missing agent while a send ran the default one.
  const agentId = readScopedAiDefault(sourceScopeId, "agentId");
  if (agentId == null || isAgentInEveryProject(agentId, carry.agent)) {
    carryScopedAiDefault(sourceScopeId, destScopeId, "agentId");
  }
}

/**
 * Plan and Exec are built in, so every project has them (its own definition, if it overrides
 * one), even before the source composer loaded its agents. Built-in and global agents exist in
 * every project too.
 */
function isAgentInEveryProject(agentId: string, agent: CreationDraftAgent | undefined): boolean {
  if ((UI_MODE_VALUES as readonly string[]).includes(agentId)) return true;
  return agent?.id === agentId && agent.scope !== "project";
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
