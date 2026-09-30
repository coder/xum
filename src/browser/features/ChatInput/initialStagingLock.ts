// Memory-only lock marking workspaces whose creation-flow staging + initial
// send is still in flight. The mounted workspace composer disables itself
// while locked so a user send cannot leapfrog the initial message and a
// failure transfer cannot overwrite a freshly typed draft. Deliberately not
// persisted: a reload kills the creation flow, so the lock must die with it.
const lockedWorkspaceIds = new Set<string>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function lockInitialStaging(workspaceId: string): void {
  lockedWorkspaceIds.add(workspaceId);
  notify();
}

export function unlockInitialStaging(workspaceId: string): void {
  if (lockedWorkspaceIds.delete(workspaceId)) {
    notify();
  }
}

export function isInitialStagingLocked(workspaceId: string): boolean {
  return lockedWorkspaceIds.has(workspaceId);
}

export function subscribeInitialStagingLock(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
