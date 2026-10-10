/**
 * Frontend signal for a changed MCP enablement: a saved workspace MCP configuration
 * (WorkspaceMCPModal, the only renderer writer of workspace overrides) or a global server
 * toggle in Settings → MCP (`mcp.setEnabled`, which also enables plugin servers for every
 * eligible workspace), or a changed project trust (project plugins and their servers load only
 * in trusted projects).
 *
 * Plugin views list whether their server is enabled for the workspace. Without this signal a
 * view whose server the user just enabled kept its stale "server is off" subtitle in the
 * command palette and the Artifacts picker until the workspace changed. Module-level and
 * unbuffered on purpose, like agentPluginMutations: only mounted consumers need to re-query.
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
