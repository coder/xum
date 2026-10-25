import type { WorkspaceActivitySnapshot } from "@/common/types/workspace";
import { isWorkspaceActivityBusy } from "@/common/utils/workspaceActivity";
import assert from "@/common/utils/assert";
import { log } from "@/node/services/log";

/**
 * Structural subset of Electron's `powerSaveBlocker` so the controller can be unit-tested
 * without Electron. `prevent-display-sleep` implies `prevent-app-suspension`, so a single
 * blocker type covers both the display and system idle sleep.
 */
export interface PowerSaveBlockerLike {
  start(type: "prevent-display-sleep"): number;
  stop(id: number): boolean;
  isStarted(id: number): boolean;
}

export interface WorkspaceActivityEvent {
  workspaceId: string;
  activity: WorkspaceActivitySnapshot | null;
}

/** Structural subset of WorkspaceService the controller depends on. */
export interface WorkspaceActivitySource {
  on(event: "activity", listener: (event: WorkspaceActivityEvent) => void): unknown;
  off(event: "activity", listener: (event: WorkspaceActivityEvent) => void): unknown;
  getActivityList(): Promise<Record<string, WorkspaceActivitySnapshot> | null>;
}

export interface KeepAwakeControllerDeps {
  blocker: PowerSaveBlockerLike;
  /** Current value of the persisted opt-in (`config.keepScreenAwake`). */
  isEnabled: () => boolean;
  /** Subscribe to config edits made by this process; returns the unsubscribe function. */
  onEnabledChanged: (callback: () => void) => () => void;
  activity: WorkspaceActivitySource;
}

/**
 * Holds exactly one Electron display-sleep blocker while the opt-in setting is enabled AND
 * at least one local workspace is working (see `isWorkspaceActivityBusy`). The blocker is
 * released the moment every workspace is idle, the setting is turned off, or the app quits.
 *
 * Purely event-driven: no timers or grace periods, because the workspace activity stream and
 * config-change notifications are deterministic signals for both edges.
 */
export class KeepAwakeController {
  private readonly deps: KeepAwakeControllerDeps;
  private readonly busy = new Set<string>();
  private blockerId: number | null = null;
  private subscribed = false;
  private disposed = false;
  private unsubscribeConfig: (() => void) | null = null;
  /**
   * Non-null only while `start()` awaits the activity snapshot: ids that received a live
   * event during that window are newer than the snapshot and must not be overwritten by it.
   */
  private liveTouchedDuringSeed: Set<string> | null = null;

  constructor(deps: KeepAwakeControllerDeps) {
    this.deps = deps;
  }

  async start(): Promise<void> {
    assert(!this.disposed, "KeepAwakeController.start() called after dispose()");
    assert(!this.subscribed, "KeepAwakeController.start() called twice");
    this.subscribed = true;

    // Subscribe BEFORE reading the snapshot so a stream that starts or ends while the read
    // is in flight is never lost or resurrected by the (older) snapshot.
    this.deps.activity.on("activity", this.onActivity);
    this.unsubscribeConfig = this.deps.onEnabledChanged(this.onConfigChanged);

    this.liveTouchedDuringSeed = new Set();
    let snapshot: Record<string, WorkspaceActivitySnapshot> | null = null;
    try {
      snapshot = await this.deps.activity.getActivityList();
    } catch (error) {
      // The live subscription is already active; a failed seed only delays the first
      // acquire until the next activity event.
      log.error("keep-awake: failed to read the initial activity list", { error });
    }
    if (this.disposed) {
      return;
    }
    const liveTouched = this.liveTouchedDuringSeed;
    this.liveTouchedDuringSeed = null;
    for (const [workspaceId, activity] of Object.entries(snapshot ?? {})) {
      if (liveTouched.has(workspaceId)) {
        continue;
      }
      if (isWorkspaceActivityBusy(activity)) {
        this.busy.add(workspaceId);
      }
    }
    this.reconcile();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.subscribed) {
      this.deps.activity.off("activity", this.onActivity);
    }
    this.unsubscribeConfig?.();
    this.unsubscribeConfig = null;
    this.busy.clear();
    this.release();
  }

  // Listener bodies are isolated: a failure here must never propagate into the
  // WorkspaceService emit path (which would disrupt the stream that produced the event).
  private readonly onActivity = (event: WorkspaceActivityEvent): void => {
    try {
      this.handleActivity(event);
    } catch (error) {
      log.error("keep-awake: failed to handle activity event", { error });
    }
  };

  private readonly onConfigChanged = (): void => {
    try {
      this.reconcile();
    } catch (error) {
      log.error("keep-awake: failed to reconcile after config change", { error });
    }
  };

  private handleActivity(event: WorkspaceActivityEvent): void {
    // Goal-only pushes overlay a goal onto a possibly stale baseline snapshot; the renderer
    // merges only the goal from them, so they carry no authoritative busy signal either.
    if (event.activity?.transientGoalOnly === true) {
      return;
    }
    this.liveTouchedDuringSeed?.add(event.workspaceId);
    if (isWorkspaceActivityBusy(event.activity)) {
      this.busy.add(event.workspaceId);
    } else {
      this.busy.delete(event.workspaceId);
    }
    this.reconcile();
  }

  private reconcile(): void {
    if (this.disposed) {
      return;
    }
    const want = this.deps.isEnabled() && this.busy.size > 0;
    if (want && this.blockerId === null) {
      const id = this.deps.blocker.start("prevent-display-sleep");
      assert(
        this.deps.blocker.isStarted(id),
        "powerSaveBlocker.start returned an id that is not running"
      );
      this.blockerId = id;
      log.debug("keep-awake: acquired display-sleep blocker", { id, busy: this.busy.size });
    } else if (!want) {
      this.release();
    }
  }

  private release(): void {
    if (this.blockerId === null) {
      return;
    }
    const id = this.blockerId;
    this.blockerId = null;
    const stopped = this.deps.blocker.stop(id);
    log.debug("keep-awake: released display-sleep blocker", { id, stopped });
  }
}
