import type {
  MonitorArmedPayload,
  MonitorStoppedPayload,
} from "@/node/services/backgroundProcessManager";
import type { BashMonitorRegistryStore } from "@/node/services/bashMonitorRegistryStore";
import { log } from "@/node/services/log";

const BASH_MONITOR_PERSIST_RETRY_DELAYS_MS = [50, 200] as const;

/** A failed monitor's persistence chain; a later cancellation of the same monitor marks it. */
interface FailurePersist {
  createdAt: string;
  canceled: boolean;
}

export interface BashMonitorPersistenceDeps {
  /** Read at call time: WorkspaceService owns the store (its tests swap it). */
  registry(): Pick<BashMonitorRegistryStore, "upsert" | "remove" | "recordTerminal" | "recordLost">;
  /** BashMonitorWakeReconciler.discardProcess, read at call time for the same reason. */
  discardProcess(workspaceId: string, processId: string, createdAt: string): Promise<void>;
  /** True while WorkspaceService removes the workspace: nothing more is persisted then. */
  isRemoving(workspaceId: string): boolean;
  /** Called once a monitor event is durable, so the wake reconciler re-reads the registry. */
  onPersisted(workspaceId: string): void;
}

/**
 * Writes bash monitor lifecycle events (armed, stopped) to the monitor registry, with a short
 * retry for failed writes, and lets removal wait until a workspace's writes have settled. Built
 * by WorkspaceService next to BashMonitorWakeReconciler, which reads the same registry.
 */
export class BashMonitorPersistence {
  private readonly pendingBashMonitorPersistenceByWorkspace = new Map<string, Set<Promise<void>>>();
  // Failed-persistence chains active per process, so a later cancellation (task_stop after a
  // runtime failure) can invalidate in-flight persists and scheduled retries by generation.
  // "failed" can never follow "canceled" for one generation (stopMonitor guards on
  // monitor.stopped), so tracking only live failed chains suffices; the owning chain removes
  // its entry on termination, keeping the map bounded by in-flight failure persists.
  private readonly activeBashMonitorFailurePersists = new Map<string, FailurePersist>();

  constructor(private readonly deps: BashMonitorPersistenceDeps) {}

  /** Waits until every monitor write started for the workspace has settled. */
  async drainBashMonitorPersistence(workspaceId: string): Promise<void> {
    const pending = this.pendingBashMonitorPersistenceByWorkspace.get(workspaceId);
    if (pending != null) await Promise.allSettled([...pending]);
  }

  onMonitorArmed(payload: MonitorArmedPayload): void {
    if (this.deps.isRemoving(payload.workspaceId)) return;
    const persistence = this.deps
      .registry()
      .upsert(payload)
      .then(() => this.deps.onPersisted(payload.workspaceId));
    void this.trackBashMonitorPersistence(payload.workspaceId, persistence).catch(
      (error: unknown) => {
        log.error("Failed to persist armed bash monitor", {
          workspaceId: payload.workspaceId,
          error,
        });
      }
    );
  }

  onMonitorStopped(workspaceId: string, payload: MonitorStoppedPayload): void {
    const processKey = workspaceId + "\u0000" + payload.processId;
    const createdAt = payload.armMetadata?.createdAt;
    if (payload.reason === "canceled" && createdAt != null) {
      this.cancelFailurePersist(processKey, createdAt);
    }
    const failurePersist =
      payload.reason === "failed" && createdAt != null
        ? this.startFailurePersist(processKey, createdAt)
        : undefined;
    const wasCanceled = (): boolean => failurePersist?.canceled === true;
    const persistence = this.persistWithRetries(
      workspaceId,
      () => this.persistStopped(workspaceId, payload, wasCanceled),
      wasCanceled,
      () => this.settleFailurePersist(processKey, failurePersist)
    );
    void this.trackBashMonitorPersistence(workspaceId, persistence);
  }

  private cancelFailurePersist(processKey: string, createdAt: string): void {
    const active = this.activeBashMonitorFailurePersists.get(processKey);
    if (active?.createdAt === createdAt) active.canceled = true;
  }

  private startFailurePersist(processKey: string, createdAt: string): FailurePersist {
    const failurePersist = { createdAt, canceled: false };
    this.activeBashMonitorFailurePersists.set(processKey, failurePersist);
    return failurePersist;
  }

  private settleFailurePersist(
    processKey: string,
    failurePersist: FailurePersist | undefined
  ): void {
    if (
      failurePersist != null &&
      this.activeBashMonitorFailurePersists.get(processKey) === failurePersist
    ) {
      this.activeBashMonitorFailurePersists.delete(processKey);
    }
  }

  private trackBashMonitorPersistence(workspaceId: string, promise: Promise<void>): Promise<void> {
    const pending =
      this.pendingBashMonitorPersistenceByWorkspace.get(workspaceId) ?? new Set<Promise<void>>();
    this.pendingBashMonitorPersistenceByWorkspace.set(workspaceId, pending);
    const tracked = promise.finally(() => {
      pending.delete(tracked);
      if (pending.size === 0) this.pendingBashMonitorPersistenceByWorkspace.delete(workspaceId);
    });
    pending.add(tracked);
    return tracked;
  }

  /**
   * Runs `persist` until it settles, retrying a rejection after each delay. Resolves (never
   * rejects) once it is done, given up, canceled, or the workspace is being removed;
   * `onSettled` runs just before.
   */
  private persistWithRetries(
    workspaceId: string,
    persist: () => Promise<boolean>,
    wasCanceled: () => boolean,
    onSettled: () => void
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      let retryIndex = 0;
      const finish = (): void => {
        onSettled();
        resolve();
      };
      const retry = (error: unknown): void => {
        const delay = BASH_MONITOR_PERSIST_RETRY_DELAYS_MS[retryIndex++];
        if (delay == null) {
          log.error("Failed to retire bash monitor state", { workspaceId, error });
          finish();
          return;
        }
        const timer = setTimeout(run, delay);
        timer.unref();
      };
      const run = (): void => {
        if (this.deps.isRemoving(workspaceId) || wasCanceled()) {
          finish();
          return;
        }
        void persist()
          .then((persisted) => {
            // mutation-equivalent: persistFailed already returns false once canceled, and no
            // cancellation can land between its return and this callback.
            if (persisted && !wasCanceled()) {
              this.deps.onPersisted(workspaceId);
            }
            finish();
          })
          .catch((error: unknown) => {
            if (wasCanceled()) {
              finish();
              return;
            }
            retry(error);
          });
      };
      run();
    });
  }

  /** Records a stopped monitor; resolves false when nothing needs a reconcile. */
  private async persistStopped(
    workspaceId: string,
    payload: MonitorStoppedPayload,
    wasCanceled: () => boolean
  ): Promise<boolean> {
    const createdAt = payload.armMetadata?.createdAt;
    if (payload.reason === "canceled") {
      if (createdAt == null) return false;
      await this.deps.discardProcess(workspaceId, payload.processId, createdAt);
      await this.deps.registry().remove(workspaceId, payload.processId, createdAt);
      return true;
    }
    if (payload.reason === "failed") {
      return await this.persistFailed(workspaceId, payload, wasCanceled);
    }
    if (payload.terminal != null && createdAt != null) {
      await this.deps
        .registry()
        .recordTerminal(workspaceId, payload.processId, createdAt, payload.terminal);
    }
    return true;
  }

  private async persistFailed(
    workspaceId: string,
    payload: MonitorStoppedPayload,
    wasCanceled: () => boolean
  ): Promise<boolean> {
    const createdAt = payload.armMetadata?.createdAt;
    if (wasCanceled()) return false;
    if (payload.armMetadata != null) {
      await this.deps.registry().upsert(payload.armMetadata);
    }
    if (wasCanceled()) return false;
    if (!(await this.recordFailedTerminal(workspaceId, payload))) return false;
    if (wasCanceled()) return false;
    if (createdAt == null) return false;
    await this.deps
      .registry()
      .recordLost(workspaceId, payload.processId, createdAt, runtimeFailureLoss(payload));
    // mutation-equivalent: persistWithRetries checks wasCanceled() again before it reconciles.
    return !wasCanceled();
  }

  /** Records a failed monitor's terminal summary, if any; false when it has no generation. */
  private async recordFailedTerminal(
    workspaceId: string,
    payload: MonitorStoppedPayload
  ): Promise<boolean> {
    if (payload.terminal == null) return true;
    const createdAt = payload.armMetadata?.createdAt;
    if (createdAt == null) return false;
    await this.deps
      .registry()
      .recordTerminal(workspaceId, payload.processId, createdAt, payload.terminal);
    return true;
  }
}

type LostRecord = Parameters<BashMonitorRegistryStore["recordLost"]>[3];

function runtimeFailureLoss(payload: MonitorStoppedPayload): LostRecord {
  return {
    reason: "runtime-failure",
    ...(payload.failureMessage != null ? { failureMessage: payload.failureMessage } : {}),
    ...(payload.failedOperations != null ? { failedOperations: payload.failedOperations } : {}),
    ...(payload.failedMatch != null ? { failedMatch: payload.failedMatch } : {}),
    failedAt: new Date().toISOString(),
  };
}
