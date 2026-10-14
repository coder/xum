/**
 * Frontend signal for a changed MCP enablement: a saved workspace MCP configuration
 * (WorkspaceMCPModal, the only renderer writer of workspace overrides) or a global server
 * toggle in Settings → MCP (`mcp.setEnabled`, which also enables plugin servers for every
 * eligible workspace), or a changed project trust (project plugins and their servers load only
 * in trusted projects).
 *
 * MCP App entry points are listed only for the servers enabled in a workspace. Without this
 * signal an entry point of a server the user just enabled (or disabled) stayed missing (or
 * stale) in the New tab launcher and the command palette until the workspace changed.
 * Module-level and unbuffered on purpose, like agentPluginMutations: only mounted consumers
 * need to re-query.
 */

/** `null`: the change can affect every workspace. */
const listeners = new Set<(workspaceId: string | null) => void>();

export function publishWorkspaceMcpOverridesSaved(workspaceId: string): void {
  for (const listener of listeners) {
    listener(workspaceId);
  }
}

export function publishGlobalMcpEnablementChanged(): void {
  for (const listener of listeners) {
    listener(null);
  }
}

/** Trust is per project; listeners re-check every workspace (they hold no project paths). */
export function publishProjectTrustChanged(): void {
  publishGlobalMcpEnablementChanged();
}

/** Subscribe a mounted consumer; returns an unsubscribe. */
export function subscribeWorkspaceMcpOverridesSaved(
  listener: (workspaceId: string | null) => void
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
