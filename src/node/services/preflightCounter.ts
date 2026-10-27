/**
 * A per-workspace count of in-flight preflight operations (bash exec, attachment staging, file
 * completion, fork, refine, send).
 *
 * The archive and interrupt gates of WorkspaceService refuse while a count is above zero. The
 * caller must call acquire() in the same synchronous block as its entry guard (for example the
 * archivingWorkspaces check): an operation admitted first then holds the gate open until it
 * disposes the admission, and one entering after the gate armed observes the gate and refuses.
 */
export class PreflightCounter {
  private readonly counts = new Map<string, number>();

  /** Count one operation for the workspace; dispose the result when the operation settles. */
  acquire(workspaceId: string): Disposable {
    const counts = this.counts;
    counts.set(workspaceId, (counts.get(workspaceId) ?? 0) + 1);
    return {
      [Symbol.dispose]: () => {
        const remaining = (counts.get(workspaceId) ?? 1) - 1;
        if (remaining <= 0) {
          counts.delete(workspaceId);
        } else {
          counts.set(workspaceId, remaining);
        }
      },
    };
  }

  /** The operations in flight for one workspace. */
  count(workspaceId: string): number {
    return this.counts.get(workspaceId) ?? 0;
  }

  /** The operations in flight across all workspaces. */
  total(): number {
    let sum = 0;
    for (const count of this.counts.values()) sum += count;
    return sum;
  }

  /** The workspaces with at least one operation in flight. */
  workspaceIds(): IterableIterator<string> {
    return this.counts.keys();
  }
}
