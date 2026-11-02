/**
 * Send preflight: the sends between their entry check and their settled outcome, the arrival
 * tickets of sends the session cannot observe yet, and the send ids of idempotent sends.
 *
 * Moved out of WorkspaceService without logic changes. WorkspaceService still runs every send
 * entry guard and calls sends.acquire() in the same synchronous block, so the archive, refine
 * and context-mutation gates always observe a send that passed its guards. getSendStatus()
 * stays in WorkspaceService and reads the send ids through the accessors here.
 */
import { PreflightCounter } from "@/node/services/preflightCounter";

export interface SendPreflightDeps {
  /**
   * Dispatch the messages queued behind a released head-of-line preflight (the session's
   * queue). A no-op when no session exists or it is busy.
   */
  drainQueuedMessagesIfIdle(workspaceId: string): void;
}

export class SendPreflight {
  // r41: sends currently between the entry check and their settled outcome
  // (queued, refused, or admitted — PREPARING is set before any early
  // background-start return). Refine publication must not interleave with a
  // send's pre-admission window: a proposal row published and RELEASED while
  // a send with an already-persisted user row awaits admission would land
  // after that user row and enter the send's request as a trailing foreign
  // assistant row (see acquireIdleTurnExclusion).
  readonly sends = new PreflightCounter();
  /**
   * Idempotent sends: this process's identity as a send receiver (getSendStatus). A process
   * restart is a new receiver: requests it had died with it.
   */
  readonly sendReceiverId = crypto.randomUUID();
  /** Send ids of sendMessage calls still running, per workspace (a count per id). */
  private readonly inFlightSendIds = new Map<string, Map<string, number>>();
  /**
   * Send ids this receiver answered "not accepted" (getSendStatus), per workspace: a later arrival
   * of one is refused, so a send the client already made visible again is never also appended.
   * Never evicted for this process's life (a restart is a new receiver: its requests died with
   * the old one), nor when the workspace is removed. Memory grows by one short string per id a
   * client looked up that this process held nowhere (at most 100 per call). An id this process
   * never saw must be remembered too: it may be a request still in transit. Clients look up only
   * their own unresolved sends, so this stays about one entry per such send.
   */
  private readonly refusedSendIds = new Map<string, Set<string>>();
  /**
   * Codex P1 (PRRT_kwDOPxxmWM6cRi_J): sends the SESSION cannot observe yet —
   * counted from service entry until the queue/session handoff, then released.
   * Unlike sends (held for the whole service call for archive
   * and refine interlocks), this feeds the session's follow-up idle probes:
   * a follow-up redispatched from within the originating send's own turn
   * (e.g. its on-send compaction completing) must not veto itself, and once
   * handed off the session's own queue/turn-phase state governs visibility.
   * Tickets are kept in arrival order so a send can tell whether an EARLIER send is
   * still in preflight (sendMessage queues behind it) without two simultaneous
   * arrivals each deferring to the other, and so sends reach their queue-or-direct
   * decision in arrival order (a later arrival must not enqueue first because its
   * preflight awaits finished sooner). Supersedable tickets are maintenance sends that
   * yield to user input (requireIdle skips and queue-mode heartbeats): they never count
   * as "earlier" for anyone, nobody waits on them, and they yield to a manual send in
   * preflight through sends.
   */
  private readonly sessionInvisiblePreflights = new Map<
    string,
    Map<
      number,
      { supersedable: boolean; manual: boolean; decided: Promise<void>; markDecided: () => void }
    >
  >();
  private nextSessionInvisiblePreflightTicket = 0;

  hasSessionInvisiblePreflight(workspaceId: string): boolean {
    return (this.sessionInvisiblePreflights.get(workspaceId)?.size ?? 0) > 0;
  }

  /**
   * A user send in service preflight (a `manual` ticket): auto-retry defers to it, since its
   * acceptance cancels the retry. Resumes, automatic and yielding sends do not hold a retry back.
   */
  hasManualSessionInvisiblePreflight(workspaceId: string): boolean {
    for (const entry of this.sessionInvisiblePreflights.get(workspaceId)?.values() ?? []) {
      if (entry.manual) return true;
    }
    return false;
  }

  /**
   * See sessionInvisiblePreflights. Release is idempotent. Disposal (scope exit of the
   * service call) also drains messages queued behind this preflight when it is a
   * blocking ticket with no blocking ticket before it (the head of the line that others
   * queue behind): those entries have no stream end to drain them if this send settled
   * without a turn (refused, rejected, startup failed). A younger send that settles
   * first must not drain, or it would dispatch entries ahead of the older still-live
   * preflight; the older send drains when it settles. Supersedable tickets never drain
   * because nothing queues behind them, and the drain is a no-op when a turn was handed
   * off (the session is busy).
   */
  armSessionInvisiblePreflight(
    workspaceId: string,
    options?: { supersedable?: boolean; manual?: boolean }
  ): {
    release: () => void;
    hasEarlierPreflight: () => boolean;
    /** Resolve once every earlier blocking ticket has reached its queue-or-direct decision. */
    awaitEarlierDecisions: () => Promise<void>;
    markDecided: () => void;
  } & Disposable {
    const supersedable = options?.supersedable === true;
    const manual = options?.manual === true && !supersedable;
    const { ticket, markDecided } = this.addSessionInvisibleTicket(workspaceId, {
      supersedable,
      manual,
    });
    let released = false;
    let releasedAsHead = false;
    const earlierBlockingTickets = (): Array<{ decided: Promise<void> }> =>
      released ? [] : this.earlierBlockingTickets(workspaceId, ticket);
    const hasEarlierPreflight = () => earlierBlockingTickets().length > 0;
    const release = () => {
      if (released) {
        return;
      }
      releasedAsHead = !supersedable && !hasEarlierPreflight();
      released = true;
      // A send that leaves before deciding must not keep later arrivals waiting.
      markDecided();
      this.deleteSessionInvisibleTicket(workspaceId, ticket);
    };
    return {
      release,
      hasEarlierPreflight,
      awaitEarlierDecisions: async () => {
        await Promise.all(earlierBlockingTickets().map((entry) => entry.decided));
      },
      markDecided,
      [Symbol.dispose]: () => {
        release();
        if (releasedAsHead) {
          this.deps.drainQueuedMessagesIfIdle(workspaceId);
        }
      },
    };
  }

  constructor(private readonly deps: SendPreflightDeps) {}

  /** Register the next arrival ticket of the workspace (see sessionInvisiblePreflights). */
  private addSessionInvisibleTicket(
    workspaceId: string,
    kind: { supersedable: boolean; manual: boolean }
  ): { ticket: number; markDecided: () => void } {
    const ticket = this.nextSessionInvisiblePreflightTicket++;
    let tickets = this.sessionInvisiblePreflights.get(workspaceId);
    if (tickets == null) {
      tickets = new Map();
      this.sessionInvisiblePreflights.set(workspaceId, tickets);
    }
    let markDecided!: () => void;
    const decided = new Promise<void>((resolve) => {
      markDecided = resolve;
    });
    tickets.set(ticket, { ...kind, decided, markDecided });
    return { ticket, markDecided };
  }

  /** The live blocking (not supersedable) tickets that arrived before this one. */
  private earlierBlockingTickets(
    workspaceId: string,
    ticket: number
  ): Array<{ decided: Promise<void> }> {
    const earlier: Array<{ decided: Promise<void> }> = [];
    // Map iteration follows insertion order, so tickets before this one arrived earlier.
    for (const [liveTicket, entry] of this.sessionInvisiblePreflights.get(workspaceId) ?? []) {
      if (liveTicket === ticket) {
        break;
      }
      if (!entry.supersedable) {
        earlier.push(entry);
      }
    }
    return earlier;
  }

  private deleteSessionInvisibleTicket(workspaceId: string, ticket: number): void {
    // dry-duplicate-ok: the match (sessionUsageService) only shares the shape "delete a key, then
    // drop the emptied map"; it tracks live usage keys and changes apart.
    const live = this.sessionInvisiblePreflights.get(workspaceId);
    live?.delete(ticket);
    if (live?.size === 0) {
      this.sessionInvisiblePreflights.delete(workspaceId);
    }
  }

  /** A send or resume of the workspace is between its entry check and its settled outcome. */
  hasSendInPreflight(workspaceId: string): boolean {
    return this.sends.count(workspaceId) > 0;
  }

  /** One of the ids was already answered "not accepted" (see refusedSendIds). */
  isSendIdRefused(workspaceId: string, sendIds: readonly string[]): boolean {
    const refused = this.refusedSendIds.get(workspaceId);
    return sendIds.some((id) => refused?.has(id) === true);
  }

  /**
   * Register the ids as running until the returned disposable is disposed. The caller must
   * check isSendIdRefused in the same synchronous block, so getSendStatus sees one or the other.
   */
  trackInFlightSendIds(workspaceId: string, sendIds: readonly string[]): Disposable {
    const key = workspaceId;
    const inFlight = this.inFlightSendIds.get(key) ?? new Map<string, number>();
    this.inFlightSendIds.set(key, inFlight);
    for (const id of sendIds) inFlight.set(id, (inFlight.get(id) ?? 0) + 1);
    return {
      [Symbol.dispose]: () => this.releaseInFlightSendIds(key, inFlight, sendIds),
    };
  }

  private releaseInFlightSendIds(
    key: string,
    inFlight: Map<string, number>,
    sendIds: readonly string[]
  ): void {
    for (const id of sendIds) {
      const count = inFlight.get(id) ?? 0;
      if (count > 1) inFlight.set(id, count - 1);
      else inFlight.delete(id);
    }
    if (inFlight.size === 0 && this.inFlightSendIds.get(key) === inFlight)
      this.inFlightSendIds.delete(key);
  }

  /** The ids of sendMessage calls still running for the workspace. */
  inFlightSendIdsOf(workspaceId: string): Iterable<string> {
    return this.inFlightSendIds.get(workspaceId)?.keys() ?? [];
  }

  /** Remember an id answered "not accepted": a later arrival of it is refused. */
  refuseSendId(workspaceId: string, sendId: string): void {
    // dry-duplicate-ok: the match (sshConnectionPool) only shares the shape "get or create a Set,
    // then add"; it tracks SSH control paths and changes apart.
    const refused = this.refusedSendIds.get(workspaceId) ?? new Set<string>();
    this.refusedSendIds.set(workspaceId, refused);
    refused.add(sendId);
  }
}
