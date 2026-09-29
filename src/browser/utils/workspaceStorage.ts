/**
 * Browser-side lifecycle of workspace-scoped persisted keys (fork copy, delete, rename).
 *
 * Kept out of src/common/constants/storage.ts because that module is also imported by node code,
 * and routed through the persisted-state helpers so every write takes the shared write path.
 */
import {
  listPersistedStateKeys,
  readPersistedRawString,
  removePersistedStateKeys,
  writePersistedRawString,
} from "@/browser/hooks/usePersistedState";
import {
  MCP_TEST_RESULTS_KEY_PREFIX,
  WORKSPACE_KEY_REGISTRATIONS,
  isWorkspaceStorageGcCandidateKey,
} from "@/common/constants/storage";

/**
 * Copy all workspace-specific localStorage keys from source to destination workspace.
 * Includes registry keys marked copyOnFork (model, review state, etc). Composer drafts are not
 * here: they live on the backend, whose fork copies the draft (DraftService).
 */
export function copyWorkspaceStorage(sourceWorkspaceId: string, destWorkspaceId: string): void {
  for (const { getKey, copyOnFork } of WORKSPACE_KEY_REGISTRATIONS) {
    if (!copyOnFork) continue;
    const value = readPersistedRawString(getKey(sourceWorkspaceId));
    if (value !== null) {
      // Copy the serialized value verbatim so the destination is byte-identical to the source.
      writePersistedRawString(getKey(destWorkspaceId), value);
    }
  }
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
 * Should be called when a workspace is renamed to preserve settings
 */
export function migrateWorkspaceStorage(oldWorkspaceId: string, newWorkspaceId: string): void {
  copyWorkspaceStorage(oldWorkspaceId, newWorkspaceId);
  deleteWorkspaceStorage(oldWorkspaceId);
}
