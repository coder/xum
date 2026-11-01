/**
 * The usage revision of each workspace. It moves on every write to a workspace's usage files
 * (SessionUsageService.onUsageChanged), so a renderer can refetch that workspace's usage and its
 * ancestors' sub-agent projections. A session-usage-delta reaches only a live session's
 * subscribed chat, and nothing else announces a sub-agent's in-flight or headless spend.
 *
 * A move goes out as its own usage-revision event, not as an activity snapshot: a snapshot read
 * for it could resolve after a newer activity emit and rebroadcast older activity, and a failed
 * read would drop the move.
 */
import type { WorkspaceActivitySnapshot } from "@/common/types/workspace";

export interface UsageRevisionActivityDeps {
  emitUsageRevision(workspaceId: string, usageRevision: number): void;
}

export class UsageRevisionActivity {
  private readonly revisions = new Map<string, number>();
  /** Seeded from the clock, so a restarted backend never reissues a revision a renderer saw. */
  private lastRevision = Date.now();

  constructor(private readonly deps: UsageRevisionActivityDeps) {}

  onUsageChanged(workspaceId: string): void {
    const usageRevision = ++this.lastRevision;
    this.revisions.set(workspaceId, usageRevision);
    this.deps.emitUsageRevision(workspaceId, usageRevision);
  }

  /** The activity list: a reconnecting renderer compares these with the revisions it saw. */
  withRevisions(
    snapshots: Record<string, WorkspaceActivitySnapshot>
  ): Record<string, WorkspaceActivitySnapshot> {
    return Object.fromEntries(
      Object.entries(snapshots).map(([workspaceId, snapshot]) => {
        const usageRevision = this.revisions.get(workspaceId);
        return [
          workspaceId,
          usageRevision === undefined ? snapshot : { ...snapshot, usageRevision },
        ];
      })
    );
  }

  evict(workspaceId: string): void {
    this.revisions.delete(workspaceId);
  }
}
