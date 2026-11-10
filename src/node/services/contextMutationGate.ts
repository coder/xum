/**
 * The admission gate of context-discarding history mutations (reset, full clear, destructive
 * replace): which workspaces run one right now, and how many each has completed (the epoch).
 *
 * Moved out of WorkspaceService without logic changes. WorkspaceService still checks
 * isMutating() and captures epoch() in each send's synchronous entry block, and advances the
 * epoch once a mutation is durable. The sessions stay in WorkspaceService, so the guard reaches
 * them through the deps closures.
 */
import type { Result } from "@/common/types/result";
import { Err, Ok } from "@/common/types/result";
import type { AgentSession } from "@/node/services/agentSession";

export interface ContextMutationGateDeps {
  getOrCreateSession(
    workspaceId: string
  ): Pick<AgentSession, "holdTurnAdmission" | "hasActiveOrPendingTurnWork">;
  isStreaming(workspaceId: string): boolean;
  /** SendPreflight.hasSendInPreflight: read in the same synchronous block as the busy check. */
  hasSendInPreflight(workspaceId: string): boolean;
}

export class ContextMutationGate {
  // Blocks new sends while a context-discarding history mutation (reset, full
  // clear, destructive replace) is in flight, and enforces one such mutation
  // at a time (r40). Sends already past this entry check are refused by the
  // session-level turn-admission block (AgentSession.holdTurnAdmission).
  private readonly contextMutationWorkspaces = new Set<string>();

  // r41: monotonic count of COMPLETED context-discarding mutations per
  // workspace. Sends capture it synchronously with the entry check above and
  // re-verify at their admission gates: the level-triggered admission block
  // cannot catch a mutation that started and finished while a send sat in
  // pre-admission awaits (e.g. branch-summary generation).
  private readonly contextMutationEpochs = new Map<string, number>();

  constructor(private readonly deps: ContextMutationGateDeps) {}

  /** A context-discarding mutation of the workspace is in flight. */
  isMutating(workspaceId: string): boolean {
    return this.contextMutationWorkspaces.has(workspaceId);
  }

  /** The workspaces with a context-discarding mutation in flight. */
  mutatingWorkspaceIds(): IterableIterator<string> {
    return this.contextMutationWorkspaces.values();
  }

  /** The count of completed context-discarding mutations (see contextMutationEpochs). */
  epoch(workspaceId: string): number {
    return this.contextMutationEpochs.get(workspaceId) ?? 0;
  }

  /** r41: mark a context-discarding mutation as durably committed (see contextMutationEpochs). */
  advanceContextMutationEpoch(workspaceId: string): void {
    // dry-duplicate-ok: the matches (taskService, mcpServerManager) only share the shape
    // "increment a per-key count"; they count unrelated events and change apart.
    this.contextMutationEpochs.set(
      workspaceId,
      (this.contextMutationEpochs.get(workspaceId) ?? 0) + 1
    );
  }

  /**
   * Admission guard for context-discarding history mutations (r40): reject
   * new sends at the door (contextMutationWorkspaces), block turn admission
   * inside the session, and only then verify idleness — all in one
   * synchronous block, so no turn can slip between the check and the guard
   * (see AgentSession.holdTurnAdmission for the pairing argument). Callers
   * hold the guard across the whole mutation — including the refine
   * drain/lock awaits — and must recheck busy-ness after those awaits for
   * the turn starts that bypass admission gating (in-turn compaction
   * retries observing a transient idle gap).
   *
   * Scope: process-local, like every send/rename/remove/busy guard in this
   * service. Under XUM_ALLOW_MULTIPLE_INSTANCES=1 a second backend sharing
   * the workspace can admit a send this guard never sees; sends do not
   * participate in a cross-process admission protocol (only refine's
   * durable staging/apply state does, via refine-apply.lock). Multi-instance
   * mode is a development escape hatch — concurrent turn traffic against one
   * workspace from two backends is unsupported beyond those durable-state
   * locks. See CONCURRENT BACKENDS in processLiveness.ts.
   */
  acquireContextMutationAdmissionGuard(
    workspaceId: string,
    operation: "truncate history" | "reset context" | "replace history"
  ): Result<Disposable> {
    if (this.contextMutationWorkspaces.has(workspaceId)) {
      return Err("A context reset or clear is already in progress for this workspace.");
    }
    const session = this.deps.getOrCreateSession(workspaceId);
    this.contextMutationWorkspaces.add(workspaceId);
    const admissionHold = session.holdTurnAdmission();
    const guard: Disposable = {
      [Symbol.dispose]: () => {
        this.contextMutationWorkspaces.delete(workspaceId);
        admissionHold[Symbol.dispose]();
      },
    };
    // Busy check AFTER arming the block: a turn admitted first is observed
    // here; a turn admitted later observes the block and refuses. Pending
    // mid-stream compaction counts as turn work (r43): its direct session
    // send bypasses this service's entry accounting.
    if (session.hasActiveOrPendingTurnWork() || this.deps.isStreaming(workspaceId)) {
      guard[Symbol.dispose]();
      return Err(`Cannot ${operation} while a turn is active. Press Esc to stop the stream first.`);
    }
    // r42: a send between its entry check and admission may have passed its
    // pre-persist gate but not yet appended its rows. If this mutation
    // committed first, those rows — including attacker-influenced family
    // payload rows — would land durably in the fresh context: the epoch gate
    // blocks the send's stream but cannot un-append. Refuse instead; sends
    // settle in bounded time and the user retries. Counted synchronously at
    // the send's entry, so one side always observes the other.
    if (this.deps.hasSendInPreflight(workspaceId)) {
      guard[Symbol.dispose]();
      return Err(`Cannot ${operation} while a message is being sent. Try again in a moment.`);
    }
    return Ok(guard);
  }
}
