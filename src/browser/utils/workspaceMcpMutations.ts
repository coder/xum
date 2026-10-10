/**
 * Frontend signal for a saved workspace MCP configuration (WorkspaceMCPModal is the only
 * renderer writer of workspace MCP overrides).
 *
 * Plugin views list whether their server is enabled for the workspace. Without this signal a
 * view whose server the user just enabled kept its stale "server is off" subtitle in the
 * command palette and the Artifacts picker until the workspace changed. Module-level and
 * unbuffered on purpose, like agentPluginMutations: only mounted consumers need to re-query.
 */

const listeners = new Set<(workspaceId: string) => void>();

export function publishWorkspaceMcpOverridesSaved(workspaceId: string): void {
  for (const listener of listeners) {
    listener(workspaceId);
  }
}

/** Subscribe a mounted consumer; returns an unsubscribe. */
export function subscribeWorkspaceMcpOverridesSaved(
  listener: (workspaceId: string) => void
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
