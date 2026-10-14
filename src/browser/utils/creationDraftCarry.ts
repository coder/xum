import { snapshotPendingAiSelection } from "@/browser/utils/aiSelectionIntent";
import { readScopedAiDefault, writeScopedAiDefault } from "@/browser/utils/scopedAiDefaults";
import type { ParsedRuntime } from "@/common/types/runtime";
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

/**
 * Moving a creation draft to another project (the creation header's project selector) carries
 * the settings its composer shows. Creation AI settings are project-scoped defaults, so the
 * destination project's defaults take the source's values, as if the user had picked them there.
 * Not setWorkspaceModelWithOrigin: its "user" origin would turn Auto off.
 */
export function carryCreationAiSettings(sourceProjectPath: string, destProjectPath: string): void {
  if (sourceProjectPath === destProjectPath) return;
  const sourceScopeId = getProjectScopeId(sourceProjectPath);
  const destScopeId = getProjectScopeId(destProjectPath);
  for (const field of ["agentId", "model", "thinkingLevel"] as const) {
    carryScopedAiDefault(sourceScopeId, destScopeId, field);
  }
  // Unsent picks (reasoning mode, service tier, Auto routing) replace the destination's own.
  snapshotPendingAiSelection(sourceScopeId)(destScopeId);
}

/**
 * A runtime the user picked in a creation composer, handed to the composer that opens the moved
 * draft (keyed by its draft storage scope). The pick is component state that the remount drops.
 */
const runtimeHandOffs = new Map<string, ParsedRuntime>();

/** Only between projects: Scratch has no runtime. */
export function handOffCreationRuntime(handOff: {
  sourceProjectPath: string;
  destProjectPath: string;
  draftScopeId: string;
  runtime: ParsedRuntime | null;
}): void {
  const scopes = [handOff.sourceProjectPath, handOff.destProjectPath];
  if (handOff.runtime == null || scopes.includes(SCRATCH_PROJECT_CONFIG_KEY)) return;
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
