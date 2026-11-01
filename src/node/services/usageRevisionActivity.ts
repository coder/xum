/**
 * The usage revision on activity snapshots. It moves on every write to a workspace's usage
 * files (SessionUsageService.onUsageChanged), so a renderer can refetch that workspace's usage
 * and its ancestors' sub-agent projections. A session-usage-delta reaches only a live session's
 * subscribed chat, and nothing else announces a sub-agent's in-flight or headless spend.
 */
import type { WorkspaceActivitySnapshot } from "@/common/types/workspace";
import { log } from "@/node/services/log";

export interface UsageRevisionActivityDeps {
  /** ExtensionMetadataService.getSnapshot. */
  getSnapshot(
    workspaceId: string,
    options: { throwOnError: true }
  ): Promise<WorkspaceActivitySnapshot | null>;
  /** WorkspaceService.emitWorkspaceActivity: merges the live overlays (this one too) and broadcasts. */
  emitWorkspaceActivity(workspaceId: string, snapshot: WorkspaceActivitySnapshot | null): void;
}

export class UsageRevisionActivity {
  private readonly revisions = new Map<string, number>();
  /** Seeded from the clock, so a restarted backend never reissues a revision a renderer saw. */
  private lastRevision = Date.now();
  /** Workspaces whose emit waits for its snapshot read. */
  private readonly pendingEmits = new Set<string>();

  constructor(private readonly deps: UsageRevisionActivityDeps) {}

  onUsageChanged(workspaceId: string): void {
    this.revisions.set(workspaceId, ++this.lastRevision);
    // One emit per workspace at a time. It merges the revision current when it is sent, so
    // usage writes during its snapshot read (a burst of stream steps) ride along.
    if (this.pendingEmits.has(workspaceId)) {
      return;
    }
    this.pendingEmits.add(workspaceId);
    void this.deps.getSnapshot(workspaceId, { throwOnError: true }).then(
      (snapshot) => {
        this.pendingEmits.delete(workspaceId);
        // Without an activity entry there is no snapshot to carry the revision; the first
        // snapshot of the workspace will.
        if (snapshot) {
          this.deps.emitWorkspaceActivity(workspaceId, snapshot);
        }
      },
      (error: unknown) => {
        this.pendingEmits.delete(workspaceId);
        // The next snapshot of the workspace, or the re-list after a reconnect, carries it.
        log.debug("Failed to emit activity after a usage change", { workspaceId, error });
      }
    );
  }

  withRevision(
    workspaceId: string,
    snapshot: WorkspaceActivitySnapshot
  ): WorkspaceActivitySnapshot {
    const usageRevision = this.revisions.get(workspaceId);
    return usageRevision === undefined ? snapshot : { ...snapshot, usageRevision };
  }

  /** The activity list: a reconnecting renderer compares these with the revisions it saw. */
  withRevisions(
    snapshots: Record<string, WorkspaceActivitySnapshot>
  ): Record<string, WorkspaceActivitySnapshot> {
    return Object.fromEntries(
      Object.entries(snapshots).map(([workspaceId, snapshot]) => [
        workspaceId,
        this.withRevision(workspaceId, snapshot),
      ])
    );
  }

  evict(workspaceId: string): void {
    this.revisions.delete(workspaceId);
  }
}
