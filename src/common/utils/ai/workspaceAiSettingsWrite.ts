const workspaceAiSettingsWriteChains = new Map<string, Promise<unknown>>();

/** Keep client writes that can persist workspace AI state in initiation order. */
export function serializeWorkspaceAiSettingsWrite<T>(
  workspaceId: string,
  write: () => Promise<T>
): Promise<T> {
  const previous = workspaceAiSettingsWriteChains.get(workspaceId) ?? Promise.resolve();
  const result = previous.then(write, write);
  workspaceAiSettingsWriteChains.set(workspaceId, result);

  return result.finally(() => {
    if (workspaceAiSettingsWriteChains.get(workspaceId) === result) {
      workspaceAiSettingsWriteChains.delete(workspaceId);
    }
  });
}
