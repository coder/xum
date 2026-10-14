/**
 * Browser-side lifecycle of workspace-scoped persisted keys (fork copy, delete, rename).
 *
 * Kept out of src/common/constants/storage.ts because that module is also imported by node code,
 * and routed through the persisted-state helpers so every write takes the shared write path.
 */
import {
  copyLegacyPersistedRawString,
  listPersistedStateKeys,
  readPersistedRawString,
  removePersistedStateKeys,
  writePersistedRawString,
} from "@/browser/hooks/usePersistedState";
import { boundWorkspaceNamePersistedState } from "@/browser/hooks/useWorkspaceName";
import {
  MCP_TEST_RESULTS_KEY_PREFIX,
  WORKSPACE_KEY_REGISTRATIONS,
  getWorkspaceNameStateKey,
  isWorkspaceStorageGcCandidateKey,
} from "@/common/constants/storage";

/**
 * Older builds stored workspaceNameState unbounded (the whole creation message), and a copy over
 * the destination's budget would live only in memory. Shrink it with its owner's bound; keys
 * without one stay verbatim, so an oversized value keeps its source (see migrateWorkspaceStorage).
 */
function boundOversizedValue(
  getKey: (scopeId: string) => string,
  value: string,
  maxValueChars: number
): string {
  if (value.length <= maxValueChars || getKey !== getWorkspaceNameStateKey) return value;
  try {
    const bounded = boundWorkspaceNamePersistedState(JSON.parse(value));
    return bounded ? JSON.stringify(bounded) : value;
  } catch {
    return value;
  }
}

/**
 * Copy all workspace-specific localStorage keys from source to destination workspace.
 * Includes registry keys marked copyOnFork (model, review state, etc). Composer drafts are not
 * here: they live on the backend, whose fork copies the draft (DraftService).
 * Returns false when any present value could not be written to the destination.
 */
export function copyWorkspaceStorage(sourceWorkspaceId: string, destWorkspaceId: string): boolean {
  let copiedAll = true;
  for (const { getKey, copyOnFork, maxValueChars } of WORKSPACE_KEY_REGISTRATIONS) {
    if (!copyOnFork) continue;
    const value = readPersistedRawString(getKey(sourceWorkspaceId));
    if (value === null) continue;
    // Values within budget are copied verbatim, so the destination is byte-identical to the source.
    // Legacy migration-only keys (budget 0) are carried along for the destination's own import.
    const write = maxValueChars === 0 ? copyLegacyPersistedRawString : writePersistedRawString;
    const copy = boundOversizedValue(getKey, value, maxValueChars);
    if (!write(getKey(destWorkspaceId), copy)) copiedAll = false;
  }
  return copiedAll;
}

/**
 * Delete all workspace-specific localStorage keys for a workspace
 * Should be called when a workspace is deleted to prevent orphaned data
 */
export function deleteWorkspaceStorage(workspaceId: string): void {
  const keys = WORKSPACE_KEY_REGISTRATIONS.map(({ getKey }) => getKey(workspaceId));
  // Workspace-scoped MCP test results embed the project path before the id, so they cannot be
  // addressed by id alone; scan for them.
  const mcpTestResultsSuffix = `:${workspaceId}`;
  for (const key of listPersistedStateKeys([MCP_TEST_RESULTS_KEY_PREFIX])) {
    if (key.endsWith(mcpTestResultsSuffix)) keys.push(key);
  }
  removePersistedStateKeys(keys);
}

/**
 * Every localStorage key the orphan GC could ever collect: registered workspace-scoped keys and
 * workspace-scoped mcpTestResults keys of stable workspace ids.
 */
export function listWorkspaceStorageGcCandidateKeys(): string[] {
  return listPersistedStateKeys([""]).filter(isWorkspaceStorageGcCandidateKey);
}

/**
 * Migrate all workspace-specific localStorage keys from old to new workspace ID
 * Should be called when a workspace is renamed to preserve settings.
 * If any copy fails (e.g. the quota is full), the old keys are kept: the write helpers report
 * failure instead of throwing, and deleting anyway would erase the only persisted copy.
 */
export function migrateWorkspaceStorage(oldWorkspaceId: string, newWorkspaceId: string): void {
  if (!copyWorkspaceStorage(oldWorkspaceId, newWorkspaceId)) return;
  deleteWorkspaceStorage(oldWorkspaceId);
}
