import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";

/**
 * Projects the workspace metadata fields that passive git/PR status refreshes depend on.
 *
 * Workspace metadata events arrive for every title, tag, AI-setting or task-status change, and
 * each one produces a new metadata Map. Refreshing status on all of them would spawn one backend
 * process per event, even in a hidden window, so stores refresh only when one of these inputs
 * changes for a workspace they actually display.
 *
 * Add a field here when a status refresh (GitStatusStore, PRStatusStore) or the backend
 * `workspace.executeBash` checkout resolution starts reading it.
 */
function getStatusRefreshInputs(metadata: FrontendWorkspaceMetadata): unknown[] {
  return [
    // Backend resolves the checkout (and its cwd) from projectPath + name + runtime.
    metadata.name,
    // Also keys the persisted review base ref and picks the primary repo of multi-project
    // workspaces.
    metadata.projectPath,
    // Local passive git fetches are deduplicated per project name.
    metadata.projectName,
    // Persisted checkout root the backend runs commands in.
    metadata.namedWorkspacePath,
    // Appended to the checkout root to form the backend execution cwd.
    metadata.subProjectPath,
    // Runtime type and location: passive-runtime eligibility, SSH fetch keys, checkout path.
    metadata.runtimeConfig,
    // Switches between single- and multi-project refresh paths and the repos they cover.
    metadata.projects,
    // Lifecycle states that decide whether the backend can run the command at all; a refresh
    // after they clear repopulates status that failed while they were set.
    metadata.isInitializing,
    metadata.isRemoving,
    metadata.incompatibleRuntime,
    metadata.transcriptOnly,
    metadata.archivedAt,
    metadata.unarchivedAt,
  ];
}

function haveSameStatusRefreshInputs(
  previous: FrontendWorkspaceMetadata,
  next: FrontendWorkspaceMetadata
): boolean {
  // Metadata is plain JSON from the backend, so a JSON comparison is a structural comparison.
  // A key-order difference only causes one extra refresh, which is the safe direction.
  return (
    JSON.stringify(getStatusRefreshInputs(previous)) ===
    JSON.stringify(getStatusRefreshInputs(next))
  );
}

/**
 * Lists the workspaces whose status a metadata update can change: subscribed workspaces that just
 * appeared (for example, metadata arriving after a subscription), and any workspace whose status
 * inputs changed. Unsubscribed workspaces count too, because their cached PR/stack data and fetch
 * backoff still describe the previous checkout when they are displayed again. Removed workspaces
 * need no refresh; the stores' cleanup drops their status.
 */
export function getStatusInputChanges(
  previous: ReadonlyMap<string, FrontendWorkspaceMetadata>,
  next: ReadonlyMap<string, FrontendWorkspaceMetadata>,
  isSubscribed: (workspaceId: string) => boolean
): string[] {
  const changed: string[] = [];
  for (const [workspaceId, nextMetadata] of next) {
    const previousMetadata = previous.get(workspaceId);
    if (previousMetadata == null) {
      if (isSubscribed(workspaceId)) {
        changed.push(workspaceId);
      }
      continue;
    }
    // onMetadata events replace only the changed entry, so unchanged entries keep their
    // reference and skip the structural comparison.
    if (
      previousMetadata !== nextMetadata &&
      !haveSameStatusRefreshInputs(previousMetadata, nextMetadata)
    ) {
      changed.push(workspaceId);
    }
  }
  return changed;
}
