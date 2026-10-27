import type { Result } from "@/common/types/result";
import { getErrorMessage } from "@/common/utils/errors";
import { log } from "@/node/services/log";
import type { PeerDelegatedTurnWait, TreeMessageSpec } from "@/node/services/taskService";
import type { WorkspaceTurnManager } from "@/node/services/workspaceTurnManager";
import { MutexMap } from "@/node/utils/concurrency/mutexMap";

type PeerTreeMessageSpec = Extract<TreeMessageSpec, { relation: "peer" }>;

export type ParkedPeerSend = PeerTreeMessageSpec & {
  awaitedDelegatedTurn: PeerDelegatedTurnWait;
};

/**
 * Call-time closures into TaskService. Tests spy on TaskService.flushParkedPeerSends and
 * TaskService.sendTreeMessage and swap TaskService fields, so every call goes back through it.
 */
export interface PeerSendParkingDeps {
  /** TaskService.flushParkedPeerSends, which delegates back to flushParkedPeerSends here. */
  flush: (targetId: string) => Promise<void>;
  getWorkspaceTurnManager: () => Pick<WorkspaceTurnManager, "getLiveWorkspaceTurnRegistration">;
  isWorkspaceStopInProgress: (workspaceId: string) => boolean;
  getWorkspaceStopEpoch: (workspaceId: string) => number;
  sendTreeMessage: (spec: ParkedPeerSend) => Promise<Result<unknown, { code: string }>>;
}

/** Peer messages parked behind a root's delegated workspace turn (#4997, #5271). */
export class PeerSendParking {
  /**
   * #4997: peer messages to a root whose running delegated workspace turn the sender does not
   * own, in arrival order per target. The delegated turn stays owner-only, so they wait here and
   * are delivered as ordinary new turns once its live registration is released (see
   * flushParkedPeerSends). They wait outside the target's MessageQueue on purpose: a queued
   * uncorrelated entry would supersede the delegated turn or strip the owner's continuations
   * (MessageQueue.hasAllWorkspaceTurnContinuations), and a "hold" dispatch decision blocks every
   * entry behind it, including the continuations that turn is waiting for. In-memory and
   * process-local, like the queue.
   */
  readonly parkedPeerSendsByTarget = new Map<string, ParkedPeerSend[]>();
  private readonly parkedPeerSendFlushLocks = new MutexMap<string>();
  /** #5271: new delegated-turn registrations per target (see onWorkspaceTurnRegistered). */
  readonly workspaceTurnRegistrationEpochs = new Map<string, number>();

  constructor(private readonly deps: PeerSendParkingDeps) {}

  /**
   * WorkspaceTurnTaskHost: a new delegated turn registered (#5271). A message waits once, for the
   * turn it was parked behind. Counting registrations, like the stop epochs, lets the retry's
   * admission gate see a replacement turn even after it settled, at any point before admission.
   */
  // dry-duplicate-ok: a per-key counter bump like the context-mutation and MCP option epochs, but
  // each counts a different event and changes apart; moved here from TaskService unchanged.
  onWorkspaceTurnRegistered(workspaceId: string): void {
    this.workspaceTurnRegistrationEpochs.set(
      workspaceId,
      // mutation-equivalent: 0 || 0 and 0 ?? 0 are both 0, so || and ?? agree here
      (this.workspaceTurnRegistrationEpochs.get(workspaceId) ?? 0) + 1
    );
  }

  /** The target's delegated-turn registration count (0 before the first registration). */
  registrationEpoch(targetId: string): number {
    // mutation-equivalent: stored epochs start at 1, so a stored value is never 0 and || agrees
    return this.workspaceTurnRegistrationEpochs.get(targetId) ?? 0;
  }

  /** Parked sends count against the recipient's queue cap like queued ones. */
  countParked(targetId: string): number {
    // mutation-equivalent: a length of 0 falls back to 0 too, so || and ?? agree
    return this.parkedPeerSendsByTarget.get(targetId)?.length ?? 0;
  }

  /** True while the target has a parked list, also while it drains. */
  hasParked(targetId: string): boolean {
    return this.parkedPeerSendsByTarget.has(targetId);
  }

  /** A retry leaves the parked list when it is still the head (see sendTreeMessage). */
  removeRetry(targetId: string, spec: PeerTreeMessageSpec): void {
    const parked = this.parkedPeerSendsByTarget.get(targetId);
    if (parked?.[0] === spec) parked.shift();
  }

  /** Drop every parked send for the target; true when a list existed. */
  dropParked(targetId: string): boolean {
    return this.parkedPeerSendsByTarget.delete(targetId);
  }

  /**
   * Park a peer message behind the target's delegated turn, then schedule a flush. Park first,
   * check second: the registration may have been released between the caller's synchronous
   * check and this call, and that release found nothing to flush. Only first attempts park: a
   * message that already waited is delivered once or dropped.
   */
  parkPeerSend(send: ParkedPeerSend): void {
    // mutation-equivalent: a stored list is an array, which is never falsy, so || and ?? agree
    const parked = this.parkedPeerSendsByTarget.get(send.targetId) ?? [];
    parked.push(send);
    this.parkedPeerSendsByTarget.set(send.targetId, parked);
    this.scheduleParkedPeerSendFlush(send.targetId);
  }

  /**
   * Triggered by the delegated turn's registration release and by the stop-latch release (an
   * explicit interrupt releases the registration while its latch is still held), never by a
   * timer. Flushes of one target run one at a time, in park order.
   */
  scheduleParkedPeerSendFlush(targetId: string): void {
    if (!this.parkedPeerSendsByTarget.has(targetId)) return;
    this.parkedPeerSendFlushLocks
      .withLock(targetId, () => this.deps.flush(targetId))
      .catch((error: unknown) => {
        log.error("Failed to deliver peer messages that waited for a delegated turn", {
          targetId,
          error: getErrorMessage(error),
        });
      });
  }

  async flushParkedPeerSends(targetId: string): Promise<void> {
    // While a registration or stop latch is held, stop: its release schedules the next flush.
    // The list stays registered while it drains, so a fresh send parks behind it instead of
    // overtaking the rest (see sendTreeMessage), and a user Stop that drops it ends the drain.
    const parked = this.parkedPeerSendsByTarget.get(targetId);
    let drainStarted = false;
    while (parked != null && this.parkedPeerSendsByTarget.get(targetId) === parked) {
      // Messages that waited for an earlier turn are dropped by their retry's admission gate.
      if (
        this.deps.getWorkspaceTurnManager().getLiveWorkspaceTurnRegistration(targetId) != null ||
        this.deps.isWorkspaceStopInProgress(targetId)
      ) {
        return;
      }
      if (!drainStarted) {
        drainStarted = true;
        // The owner's explicit interrupt of the delegated turn bumps the target's stop epoch (so
        // sends admitted during its wind-down cannot outlive that stop), and these messages
        // waited for the turn on purpose. Take a new target baseline once, here, not per retry:
        // a user Stop after this point still refuses a retry that is already in flight, and one
        // before it dropped the list (markParentWorkspaceInterrupted).
        const epoch = this.deps.getWorkspaceStopEpoch(targetId);
        for (const waiting of parked) waiting.awaitedDelegatedTurn.stopEpochs.set(targetId, epoch);
      }
      // The retry removes itself from the list under the target's admission lock (see
      // sendTreeMessage), so it stays counted against the queue cap until then.
      const spec = parked[0];
      if (spec == null) {
        this.parkedPeerSendsByTarget.delete(targetId);
        return;
      }
      // The retry re-runs the full peer path under the target's event lock. A withdrawn message
      // (consent revoked, sender stopped, runtime change, target archived) is dropped and
      // touches no turn state, and so is one that meets another delegated turn.
      // Each message is handled on its own, so one failure cannot discard the rest.
      try {
        const result = await this.deps.sendTreeMessage(spec);
        if (!result.success) {
          log.debug("Dropped a peer message that waited for a delegated turn", {
            senderWorkspaceId: spec.senderWorkspaceId,
            targetId,
            code: result.error.code,
          });
        }
      } catch (error) {
        log.error("Failed to deliver a peer message that waited for a delegated turn", {
          senderWorkspaceId: spec.senderWorkspaceId,
          targetId,
          error: getErrorMessage(error),
        });
      } finally {
        // A retry that never reached the lock (it threw first) must not be retried forever.
        if (parked[0] === spec) parked.shift();
      }
    }
  }
}
