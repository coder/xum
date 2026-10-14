import { getUserPreferences } from "@/browser/stores/AppConfigStore";
import { snapshotPendingAiSelection } from "@/browser/utils/aiSelectionIntent";
import { writeScopedAiDefault } from "@/browser/utils/scopedAiDefaults";
import type { ParsedRuntime } from "@/common/types/runtime";
import { getProjectScopeId } from "@/common/constants/storage";

/**
 * Moving a creation draft to another project (the creation header's project selector) carries
 * the settings its composer shows. Creation AI settings are project-scoped defaults, so the
 * destination project's defaults take the source's values, as if the user had picked them there.
 */
export function carryCreationAiSettings(sourceProjectPath: string, destProjectPath: string): void {
  if (sourceProjectPath === destProjectPath) return;
  const projectDefaults = getUserPreferences().ai?.projectDefaults;
  const source = projectDefaults?.[sourceProjectPath];
  const dest = projectDefaults?.[destProjectPath];
  const destScopeId = getProjectScopeId(destProjectPath);
  // An unset source field shows the global default there, so it clears the destination's.
  // Not setWorkspaceModelWithOrigin: its "user" origin would turn Auto off.
  if (source?.agentId !== dest?.agentId) {
    writeScopedAiDefault(destScopeId, "agentId", source?.agentId);
  }
  if (source?.model !== dest?.model) writeScopedAiDefault(destScopeId, "model", source?.model);
  if (source?.thinkingLevel !== dest?.thinkingLevel) {
    writeScopedAiDefault(destScopeId, "thinkingLevel", source?.thinkingLevel);
  }
  // Unsent picks (reasoning mode, service tier, Auto routing) replace the destination's own.
  snapshotPendingAiSelection(getProjectScopeId(sourceProjectPath))(destScopeId);
}

/**
 * A runtime the user picked in a creation composer, handed to the composer that opens the moved
 * draft (keyed by its draft storage scope). The pick is component state that the remount drops.
 */
const runtimeHandOffs = new Map<string, ParsedRuntime>();

export function handOffCreationRuntime(draftScopeId: string, runtime: ParsedRuntime): void {
  runtimeHandOffs.set(draftScopeId, runtime);
}

/** Read without consuming: StrictMode runs state initializers twice. */
export function peekCreationRuntimeHandOff(draftScopeId: string | null): ParsedRuntime | null {
  return draftScopeId != null ? (runtimeHandOffs.get(draftScopeId) ?? null) : null;
}

export function clearCreationRuntimeHandOff(draftScopeId: string): void {
  runtimeHandOffs.delete(draftScopeId);
}
