--------------------------- MODULE DelegatedTurns ---------------------------
(***************************************************************************)
(* Delegated workspace turns + peer-message (task_send_message) delivery   *)
(* into ONE target root workspace.                                          *)
(*                                                                          *)
(* Actors                                                                   *)
(*  - Owner: creates delegated turns 1..NT on the target, may interrupt     *)
(*    them (interruptWorkspaceTurn), may send OwnerMsg (a correlated        *)
(*    continuation), and may become "withdrawn" (sender stopped, consent    *)
(*    revoked, runtime changed, target archived: any dequeue-gate refusal). *)
(*  - Peers: messages 1..NM other than OwnerMsg (non-owner senders).        *)
(*  - Target session: one turn slot (idle / prep / stream) + MessageQueue.  *)
(*  - User: one hard Stop (interruptStream) and a later resume.            *)
(*  - TaskService parked-send flush (flushParkedPeerSends).                 *)
(*                                                                          *)
(* Granularity: every await-free code segment is ONE action. Comments give  *)
(* the file:line of the segment (files abbreviated: TS = taskService.ts,    *)
(* WTM = workspaceTurnManager.ts, AS = agentSession.ts,                     *)
(* WS = workspaceService.ts), at commit 491bb881b5.                        *)
(*                                                                          *)
(* Abstractions (see check.sh's header for the full list)                           *)
(*  - Stream end at a tool boundary (tool-end dispatch) and at completion   *)
(*    (turn-end) are both the single StreamEnd action: dispatch mode only   *)
(*    changes WHEN the stream ends, not what the gates check.               *)
(*  - The delegated turn's own admission gates are collapsed into Launch.   *)
(*  - Rollback of persisted rows always succeeds (a failed rollback only    *)
(*    refuses the send to its caller, which is a visible outcome).          *)
(*                                                                          *)
(* Fix flags let the checker look past a known bug to find the next one.    *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets, TLC

CONSTANTS
    NM,              \* number of messages (1..NM)
    NT,              \* number of delegated turns the owner may create (1..NT)
    OwnerMsg,        \* the owner's message id (0 = no owner message)
    MaxUserStops,    \* 0 or 1
    MaxOwnerInts,    \* owner interrupts allowed
    AllowWithdraw,   \* may the owner's continuation be withdrawn (#5261)
    Fix5277,         \* park records the epoch seen by the refusing gate
    Fix5261,         \* a withdrawn correlated continuation's deferred turn is settled once
                     \* the target is idle with an empty queue (#5308)
    FixStopPark,     \* a park after a user Stop drops the message (finding F1)
    FixRegReplace,   \* a reservation never replaces a live registration (finding F2)
    FixStaleCorr,    \* only the owner resolves a correlation, and a correlation whose
                     \* registration is gone refuses (finding F3)
    SettleUnderLock  \* Fix5261's settlement takes the target's event lock

Msgs  == 1..NM
Turns == 1..NT
None  == 0

VARIABLES
    reg,        \* live registration of the target: [t |-> 0..NT, acc |-> BOOLEAN]
    regEpoch,   \* TS workspaceTurnRegistrationEpochs[target]
    turn,       \* handle status per turn
    nextTurn,   \* next turn id the owner may create
    create,     \* per turn, the owner's createWorkspaceTurn call: [pc, mode]
                \* (calls are independent async calls, e.g. parallel tool calls)
    slot,       \* session turn slot: [k |-> "idle"|"prep"|"stream", kind |-> "turn"|"msg"|"none", id]
    queue,      \* MessageQueue entries: <<[kind |-> "msg"|"turn", id]>>
    stopEpoch,  \* TS workspaceStopEpochs[target]
    latch,      \* TS workspaceStopsInProgress[target]
    interrupted,\* TS interruptedParentWorkspaceIds contains target
    userStops,  \* ghost: completed user Stop requests
    ownerInts,  \* ghost: owner interrupts started
    ownerGone,  \* owner-sent input is withdrawn at every admission gate
    parked,     \* TS parkedPeerSendsByTarget[target]: <<[m, rEpoch, sBase]>>
    listExists, \* parkedPeerSendsByTarget.has(target)
    listGen,    \* identity of the parked list object
    fl,         \* flush: [sched, run, started, cur, gen]
    lock,       \* TS workspaceEventLocks[target] holder: 0 free, i = message i, NM+1 = stream handler
    pendingEnd, \* turns whose correlated stream ended; TS handleStreamEnd not yet run
    pendingAbort, \* turns whose stream was aborted; stream-abort handler not yet run
    intr,       \* owner interrupt in progress: [pc |-> "idle"|"stopping", t]
    ustop,      \* user stop in progress: "idle" | "stopping"
    wsettle,    \* Fix5261: per turn, "pending" while a withdrawn continuation's reconcile
                \* has not run (TS scheduleWithdrawnWorkspaceTurnContinuationReconcile), else "none"
    m           \* per-message state (see MsgInit)

vars == <<reg, regEpoch, turn, nextTurn, create, slot, queue, stopEpoch, latch,
          interrupted, userStops, ownerInts, ownerGone, parked, listExists, listGen,
          fl, lock, pendingEnd, pendingAbort, intr, ustop, wsettle, m>>

StreamLock == NM + 1

MsgInit == [pc |-> "unsent", retry |-> FALSE, sBase |-> 0, rEpoch |-> 0,
            corr |-> 0, corrDone |-> FALSE, refusal |-> "none",
            told |-> "none", out |-> "pending", why |-> "none",
            waited |-> FALSE, met |-> 0, delEpoch |-> 0,
            ustopAt |-> 0, delUstops |-> 0, ointAt |-> 0, delOints |-> 0,
            deliveries |-> 0]

Init ==
    /\ reg = [t |-> None, acc |-> FALSE]
    /\ regEpoch = 0
    /\ turn = [t \in Turns |-> "new"]
    /\ nextTurn = 1
    /\ create = [t \in Turns |-> [pc |-> "idle", mode |-> "none"]]
    /\ slot = [k |-> "idle", kind |-> "none", id |-> 0]
    /\ queue = <<>>
    /\ stopEpoch = 0
    /\ latch = 0
    /\ interrupted = FALSE
    /\ userStops = 0
    /\ ownerInts = 0
    /\ ownerGone = FALSE
    /\ parked = <<>>
    /\ listExists = FALSE
    /\ listGen = 0
    /\ fl = [sched |-> FALSE, run |-> FALSE, started |-> FALSE, cur |-> 0, gen |-> 0]
    /\ lock = 0
    /\ pendingEnd = {}
    /\ pendingAbort = {}
    /\ intr = [pc |-> "idle", t |-> 0]
    /\ ustop = "idle"
    /\ wsettle = [t \in Turns |-> "none"]
    /\ m = [i \in Msgs |-> MsgInit]

-----------------------------------------------------------------------------
(* Helpers *)

IsOwner(i) == i = OwnerMsg
Live(t) == turn[t] \in {"reserved", "running", "deferred"}
Idle == slot.k = "idle"
IdleSlot == [k |-> "idle", kind |-> "none", id |-> 0]
\* Turn (if any) the current slot occupant belongs to: a delegated turn's own
\* stream, or a message dispatched with that turn's correlation.
SlotTurn ==
    IF slot.k = "idle" THEN 0
    ELSE IF slot.kind = "turn" THEN slot.id
    ELSE m[slot.id].corr

\* Schedule a flush (TS 2515-2516: only when the list exists).
Sched(le) == IF le THEN [fl EXCEPT !.sched = TRUE] ELSE fl

\* LiveWorkspaceTurnRegistrations.delete (WTM 652-656) -> onReleased -> schedule flush (TS 2481-2483).
ReleaseIf(t) ==
    IF reg.t = t /\ t # 0
    THEN /\ reg' = [t |-> None, acc |-> FALSE]
         /\ fl' = Sched(listExists)
    ELSE UNCHANGED <<reg, fl>>

\* getDelegatedRootRefusal (TS 9717-9744).
DelegRefusal(i) ==
    LET r == m[i] IN
    IF r.retry /\ regEpoch # r.rEpoch THEN "await"             \* TS 9724-9730
    ELSE IF reg.t = None                                      \* TS 9731-9732
    THEN IF FixStaleCorr /\ r.corrDone /\ r.corr # 0 THEN "starting" ELSE "none"
    ELSE IF ~IsOwner(i) \/ r.retry THEN "await"                \* TS 9734-9736
    ELSE IF ~reg.acc THEN "starting"                          \* TS 9737
    ELSE IF ~r.corrDone THEN "none"                           \* TS 9739
    ELSE IF reg.t # r.corr THEN "starting"                    \* TS 9740-9743
    ELSE "none"

\* admissionStale (TS 10010-10106), in its evaluation order.
Stale(i) ==
    LET r == m[i] IN
    IF stopEpoch # r.sBase \/ latch > 0 THEN "stop"           \* TS 10017-10019
    ELSE IF IsOwner(i) /\ ownerGone THEN "withdrawn"           \* TS 10021-10048 (sender), 10054-10085 (consent/runtime/archive)
    ELSE IF interrupted THEN "stop"                           \* TS 10025-10027
    ELSE DelegRefusal(i)                                      \* TS 10029-10033

\* First waiting refusal: remember the registration count of the turn met (ghost).
Meet(r, s) ==
    IF s = "await" /\ ~r.retry /\ ~r.waited
    THEN [r EXCEPT !.waited = TRUE, !.met = regEpoch]
    ELSE r

\* Outcome of a refused/withdrawn attempt: the first attempt's sender sees an
\* error; a retry after a delegated turn is dropped (only logged, TS 2562-2568).
Resolve(r, why) ==
    IF r.retry THEN [r EXCEPT !.pc = "done", !.out = "dropped", !.why = why]
    ELSE [r EXCEPT !.pc = "done", !.out = "refused", !.why = why, !.told = "refused"]

\* parkPeerSend (TS 2503-2508) with the record built in park() (TS 10116-10128).
ParkRec(i, r, epoch) == [m |-> i, rEpoch |-> epoch, sBase |-> r.sBase]

Delivered(r) ==
    [r EXCEPT !.pc = "done", !.out = "delivered", !.deliveries = @ + 1,
              !.delEpoch = regEpoch, !.delUstops = userStops, !.delOints = ownerInts,
              !.told = IF r.retry THEN @ ELSE "accepted"]

ReleaseLock(i) == IF lock = i THEN 0 ELSE lock

\* A same-correlation continuation is queued, dispatching or streaming
\* (WTM hasSameTurnContinuation 5240-5263).
ContinuationPending(t) ==
    \/ \E k \in 1..Len(queue) : queue[k].kind = "msg" /\ m[queue[k].id].corr = t
    \/ slot.k # "idle" /\ slot.kind = "msg" /\ m[slot.id].corr = t

\* Fix5261 (#5308, TS scheduleWithdrawnWorkspaceTurnContinuationReconcile): withdrawing a
\* correlated continuation schedules a reconcile of its turn; WithdrawSettle runs it.
ScheduleWithdrawn(r) ==
    IF Fix5261 /\ r.corr # 0
    THEN wsettle' = [wsettle EXCEPT ![r.corr] = "pending"]
    ELSE UNCHANGED wsettle

-----------------------------------------------------------------------------
(* Peer / owner message pipeline: TS sendTreeMessage (9532-10214) *)

\* The sender calls task_send_message (first attempt) or the flush starts the
\* retry; both wait for the target's event lock (TS 9574), then run the
\* synchronous prefix up to the checkout probe await (TS 9575-9854).
Enter(i) ==
    /\ m[i].pc \in {"unsent", "retry"}
    /\ lock = 0
    /\ LET r == m[i]
           first == ~r.retry
       IN
       IF interrupted                                          \* TS 9790-9792
       THEN m' = [m EXCEPT ![i] = Resolve(r, "user_stop")] /\ UNCHANGED lock
       ELSE IF latch > 0                                       \* TS 9817-9819
       THEN m' = [m EXCEPT ![i] = Resolve(r, "stop_in_progress")] /\ UNCHANGED lock
       ELSE IF first /\ IsOwner(i) /\ ownerGone                \* TS 9641-9643
       THEN m' = [m EXCEPT ![i] = Resolve(r, "withdrawn")] /\ UNCHANGED lock
       ELSE IF first /\ IsOwner(i) /\ reg.t # None /\ ~reg.acc \* TS 9745-9747
       THEN m' = [m EXCEPT ![i] = Resolve(r, "starting")] /\ UNCHANGED lock
       ELSE /\ lock' = i
            /\ m' = [m EXCEPT ![i] =
                  [r EXCEPT !.pc = "corr",
                            \* TS 9836-9841: retry keeps its (rebased) baseline
                            !.sBase = IF first THEN stopEpoch ELSE r.sBase,
                            !.ustopAt = IF first THEN userStops ELSE r.ustopAt,
                            !.ointAt = IF first THEN ownerInts ELSE r.ointAt]]
    /\ UNCHANGED <<reg, regEpoch, turn, nextTurn, create, slot, queue, stopEpoch, latch,
                   interrupted, userStops, ownerInts, ownerGone, parked, listExists,
                   listGen, fl, pendingEnd, pendingAbort, intr, ustop>>

\* After the checkout probe and throttle: the correlation lookup
\* (TS 9921-9928 -> WTM 5582-5630, requireAcceptedRegistration).
Corr(i) ==
    /\ m[i].pc = "corr"
    /\ LET r == m[i]
           c == IF ~r.retry /\ (FixStaleCorr => IsOwner(i)) /\ reg.t # None /\ reg.acc /\ turn[reg.t] \in {"running", "deferred"}
                THEN reg.t ELSE 0
       IN m' = [m EXCEPT ![i] = [r EXCEPT !.pc = "gate1", !.corr = c, !.corrDone = TRUE]]
    /\ UNCHANGED <<reg, regEpoch, turn, nextTurn, create, slot, queue, stopEpoch, latch,
                   interrupted, userStops, ownerInts, ownerGone, parked, listExists,
                   listGen, fl, lock, pendingEnd, pendingAbort, intr, ustop>>

Park(i, r, epoch) ==
    /\ parked' = Append(parked, ParkRec(i, r, epoch))
    /\ listExists' = TRUE

\* After resolveParentAutoResumeOptions: TS 10136-10149 (sync).
Gate1(i) ==
    /\ m[i].pc = "gate1"
    /\ LET r0 == m[i]
           s == Stale(i)
           r == Meet(r0, s)
           first == ~r.retry
       IN
       IF s # "none"
       THEN IF first /\ s = "await"                            \* TS 10137 -> waitForDelegatedTurn
            THEN /\ Park(i, r, regEpoch)
                 /\ fl' = [fl EXCEPT !.sched = TRUE]
                 /\ m' = [m EXCEPT ![i] = [r EXCEPT !.pc = "done", !.told = "queued"]]
                 /\ lock' = ReleaseLock(i)
            ELSE /\ m' = [m EXCEPT ![i] = Resolve(r, s)]
                 /\ lock' = ReleaseLock(i)
                 /\ UNCHANGED <<parked, listExists, fl>>
       ELSE IF first /\ listExists /\ reg.t = None             \* TS 10142-10149: queue behind the drain
       THEN /\ Park(i, r, regEpoch)
            /\ fl' = [fl EXCEPT !.sched = TRUE]
            /\ m' = [m EXCEPT ![i] = [r EXCEPT !.pc = "done", !.told = "queued",
                                               !.waited = TRUE, !.met = regEpoch]]
            /\ lock' = ReleaseLock(i)
       ELSE /\ m' = [m EXCEPT ![i] = [r EXCEPT !.pc = "ws"]]
            /\ UNCHANGED <<parked, listExists, fl, lock>>
    /\ UNCHANGED <<reg, regEpoch, turn, nextTurn, create, slot, queue, stopEpoch, latch,
                   interrupted, userStops, ownerInts, ownerGone, listGen, pendingEnd,
                   pendingAbort, intr, ustop>>

\* WS.sendMessage after its preflight awaits: stale probes at WS 15060 (queue
\* path) / WS 15226 (direct path) return Err WITHOUT onCanceled; otherwise the
\* entry is queued (target busy, WS 15042) or the session starts preparing.
WsGate(i) ==
    /\ m[i].pc = "ws"
    /\ LET r0 == m[i]
           s == Stale(i)
           r == Meet(r0, s)
       IN
       IF s # "none"
       THEN \* TS 10189-10193: Err(awaitDelegatedTurn) or the refusal reaches the sender.
            /\ m' = [m EXCEPT ![i] = Resolve(r, s)]
            /\ lock' = ReleaseLock(i)
            /\ UNCHANGED <<slot, queue>>
       ELSE IF ~Idle
       THEN /\ queue' = Append(queue, [kind |-> "msg", id |-> i])
            /\ m' = [m EXCEPT ![i] = [r EXCEPT !.pc = "queued",
                                               !.told = IF r.retry THEN @ ELSE "queued"]]
            /\ lock' = ReleaseLock(i)
            /\ UNCHANGED slot
       ELSE /\ slot' = [k |-> "prep", kind |-> "msg", id |-> i]
            /\ m' = [m EXCEPT ![i] = [r EXCEPT !.pc = "persist"]]
            /\ UNCHANGED <<queue, lock>>
    /\ UNCHANGED <<reg, regEpoch, turn, nextTurn, create, stopEpoch, latch, interrupted,
                   userStops, ownerInts, ownerGone, parked, listExists, listGen, fl,
                   pendingEnd, pendingAbort, intr, ustop>>

\* AS 5141-5160: the final admission gate, after the pre-turn rows were appended.
\* Used by direct sends ("persist", event lock held) and dequeued entries
\* ("qpersist", no event lock).
Gate2(i) ==
    /\ m[i].pc \in {"persist", "qpersist"}
    /\ LET r0 == m[i]
           s == Stale(i)
           r == Meet(r0, s)
       IN
       IF s # "none"
       THEN /\ m' = [m EXCEPT ![i] = [r EXCEPT !.pc = "rollback", !.refusal = s]]
            /\ UNCHANGED <<slot, lock>>
       ELSE \* accepted: the stream starts (startStreamInBackground)
            /\ slot' = [k |-> "stream", kind |-> "msg", id |-> i]
            /\ m' = [m EXCEPT ![i] = Delivered(r)]
            /\ lock' = ReleaseLock(i)
    /\ UNCHANGED <<reg, regEpoch, turn, nextTurn, create, queue, stopEpoch, latch,
                   interrupted, userStops, ownerInts, ownerGone, parked, listExists,
                   listGen, fl, pendingEnd, pendingAbort, intr, ustop>>

\* AS 5142-5150: after `await rollbackPersistedTurnRows()`, onCanceled runs
\* (TS 10185-10187: park if the refusal was the delegated-turn wait), then the
\* attempt returns and frees the slot.
Rollback(i) ==
    /\ m[i].pc = "rollback"
    /\ LET r == m[i]
           doPark == ~r.retry /\ r.refusal = "await"
                     /\ ~(FixStopPark /\ userStops # r.ustopAt)
           \* #5277: park() read the registration count NOW, after the await; since
           \* #5303 it stores the count seen by the refusing gate (Fix5277).
           epoch == IF Fix5277 THEN r.met ELSE regEpoch
       IN
       /\ IF doPark
          THEN /\ Park(i, r, epoch)
               /\ fl' = [fl EXCEPT !.sched = TRUE]
               /\ m' = [m EXCEPT ![i] = [r EXCEPT !.pc = "done", !.told = "queued"]]
               /\ UNCHANGED <<turn, reg>>
          ELSE /\ m' = [m EXCEPT ![i] = Resolve(r, r.refusal)]
               /\ UNCHANGED <<parked, listExists, fl>>
       /\ ScheduleWithdrawn(r)
       /\ slot' = IdleSlot
       /\ lock' = ReleaseLock(i)
    /\ UNCHANGED <<turn, reg, regEpoch, nextTurn, create, queue, stopEpoch, latch, interrupted,
                   userStops, ownerInts, ownerGone, listGen, pendingEnd, pendingAbort,
                   intr, ustop>>

-----------------------------------------------------------------------------
(* Target session queue drain: AS sendQueuedMessages 10540-10626 (sync, no event lock) *)

Dequeue ==
    /\ Idle
    /\ latch = 0                                               \* AS 10552 stop barrier
    /\ queue # <<>>
    /\ LET e == Head(queue) IN
       IF e.kind = "turn"
       THEN \* A queued delegated turn dispatches; acceptance registers it (WTM 1995-1999).
            /\ queue' = Tail(queue)
            /\ IF turn[e.id] = "queued"
               THEN /\ slot' = [k |-> "stream", kind |-> "turn", id |-> e.id]
                    /\ turn' = [turn EXCEPT ![e.id] = "running"]
                    /\ reg' = [t |-> e.id, acc |-> TRUE]
                    /\ regEpoch' = IF reg.t # e.id THEN regEpoch + 1 ELSE regEpoch  \* WTM 644-649
               ELSE UNCHANGED <<slot, turn, reg, regEpoch>>
            /\ UNCHANGED <<m, parked, listExists, fl, wsettle>>
       ELSE
       LET i == e.id
           r0 == m[i]
           s == Stale(i)                                       \* AS 10579 dequeue gate
           r == Meet(r0, s)
       IN
       /\ queue' = Tail(queue)
       /\ IF s # "none"
          THEN \* removeEntry + notifyQueuedMessageCleared -> onCanceled, synchronously (AS 9757-9767)
               /\ IF ~r.retry /\ s = "await"
                  THEN /\ Park(i, r, regEpoch)
                       /\ fl' = [fl EXCEPT !.sched = TRUE]
                       /\ m' = [m EXCEPT ![i] = [r EXCEPT !.pc = "done"]]
                       /\ UNCHANGED slot
                  ELSE /\ m' = [m EXCEPT ![i] = Resolve(r, s)]
                       /\ UNCHANGED <<parked, listExists, slot, fl>>
               /\ ScheduleWithdrawn(r)
          ELSE /\ slot' = [k |-> "prep", kind |-> "msg", id |-> i]
               /\ m' = [m EXCEPT ![i] = [r EXCEPT !.pc = "qpersist"]]
               /\ UNCHANGED <<parked, listExists, fl, wsettle>>
       /\ UNCHANGED <<regEpoch, turn, reg>>
    /\ UNCHANGED <<nextTurn, create, stopEpoch, latch, interrupted, userStops, ownerInts,
                   ownerGone, listGen, lock, pendingEnd, pendingAbort, intr, ustop>>

-----------------------------------------------------------------------------
(* Delegated turn lifecycle (owner side): WTM createWorkspaceTurn 1274-2130 *)

\* WTM 1529: busy check decides queued vs reserved; awaits follow.
CreateDecide ==
    /\ nextTurn <= NT
    /\ ~ownerGone
    /\ ustop = "idle"
    /\ create' = [create EXCEPT ![nextTurn] =
                     [pc |-> "register", mode |-> IF Idle THEN "reserve" ELSE "queue"]]
    /\ nextTurn' = nextTurn + 1
    /\ UNCHANGED <<reg, regEpoch, turn, slot, queue, stopEpoch, latch, interrupted,
                   userStops, ownerInts, ownerGone, parked, listExists, listGen, fl, lock,
                   pendingEnd, pendingAbort, intr, ustop, m>>

\* WTM 1874-1905: persist the record and (not queued) reserve the registration.
CreateRegister(t) ==
    /\ create[t].pc = "register"
    /\ IF create[t].mode = "reserve"
       THEN IF FixRegReplace /\ reg.t # None /\ ~Idle
            THEN \* F2 fix: recheck busy-ness under the lifecycle lock and refuse a
                 \* reservation over a running turn's registration (WTM "target_busy").
                 /\ turn' = [turn EXCEPT ![t] = "error"]
                 /\ create' = [create EXCEPT ![t] = [pc |-> "done", mode |-> "none"]]
                 /\ UNCHANGED <<queue, reg, regEpoch>>
            ELSE \* Map.set with a new handle: a live entry is replaced without release (WTM 644-649).
                 /\ reg' = [t |-> t, acc |-> FALSE]
                 /\ regEpoch' = regEpoch + 1                   \* WTM 648 -> TS 2491-2496
                 /\ turn' = [turn EXCEPT ![t] = "reserved"]
                 /\ create' = [create EXCEPT ![t] = [pc |-> "launch", mode |-> "reserve"]]
                 /\ UNCHANGED queue
       ELSE /\ queue' = Append(queue, [kind |-> "turn", id |-> t])
            /\ turn' = [turn EXCEPT ![t] = "queued"]
            /\ create' = [create EXCEPT ![t] = [pc |-> "done", mode |-> "none"]]
            /\ UNCHANGED <<reg, regEpoch>>
    /\ UNCHANGED <<nextTurn, slot, stopEpoch, latch, interrupted, userStops, ownerInts, ownerGone,
                   parked, listExists, listGen, fl, lock, pendingEnd, pendingAbort, intr,
                   ustop, m>>

\* WTM 2017-2124: requireIdle send; acceptance marks the registration accepted
\* (WTM 1952-1999); a busy target refuses and settleWorkspaceTurn releases it (WTM 2916).
CreateLaunch(t) ==
    /\ create[t].pc = "launch"
    /\ create' = [create EXCEPT ![t] = [pc |-> "done", mode |-> "none"]]
    /\    IF turn[t] # "reserved"
          THEN UNCHANGED <<reg, regEpoch, turn, slot, fl>>    \* interrupted meanwhile
          ELSE IF Idle
          THEN /\ slot' = [k |-> "stream", kind |-> "turn", id |-> t]
               /\ turn' = [turn EXCEPT ![t] = "running"]
               \* markWorkspaceTurnAccepted registers this turn even if another
               \* reservation replaced it (WTM 1995-1999, 644-649).
               /\ reg' = [t |-> t, acc |-> TRUE]
               /\ regEpoch' = IF reg.t # t THEN regEpoch + 1 ELSE regEpoch
               /\ UNCHANGED fl
          ELSE /\ turn' = [turn EXCEPT ![t] = "error"]
               /\ ReleaseIf(t)
               /\ UNCHANGED <<slot, regEpoch>>
    /\ UNCHANGED <<nextTurn, queue, stopEpoch, latch, interrupted, userStops,
                   ownerInts, ownerGone, parked, listExists, listGen, lock, pendingEnd,
                   pendingAbort, intr, ustop, m>>

\* The active stream ends (tool boundary or completion). The session frees the
\* slot; TaskService handles the correlated end later under the event lock (TS 4616).
StreamEnd ==
    /\ slot.k = "stream"
    /\ LET t == SlotTurn IN
       /\ pendingEnd' = IF t # 0 THEN pendingEnd \cup {t} ELSE pendingEnd
    /\ slot' = IdleSlot
    /\ UNCHANGED <<reg, regEpoch, turn, nextTurn, create, queue, stopEpoch, latch,
                   interrupted, userStops, ownerInts, ownerGone, parked, listExists,
                   listGen, fl, lock, pendingAbort, intr, ustop, m>>

\* WTM finalizeWorkspaceTurnFromStreamEnd 5373-5526 under the event lock.
Finalize(t) ==
    /\ t \in pendingEnd
    /\ lock = 0
    /\ pendingEnd' = pendingEnd \ {t}
    /\ IF turn[t] \in {"running", "deferred"} /\ ContinuationPending(t)
       THEN /\ turn' = [turn EXCEPT ![t] = "deferred"]       \* WTM 5424-5429
            /\ UNCHANGED <<reg, fl>>
       ELSE /\ turn' = IF turn[t] \in {"running", "deferred"}
                       THEN [turn EXCEPT ![t] = "done"] ELSE turn
            /\ ReleaseIf(t)                                    \* WTM 2797 / 2916
    /\ UNCHANGED <<regEpoch, nextTurn, create, slot, queue, stopEpoch, latch, interrupted,
                   userStops, ownerInts, ownerGone, parked, listExists, listGen, lock,
                   pendingAbort, intr, ustop, m>>

\* Stream-abort handler (TS 17275-17291 -> WTM 5527-5541) under the event lock.
AbortFinalize(t) ==
    /\ t \in pendingAbort
    /\ lock = 0
    /\ pendingAbort' = pendingAbort \ {t}
    /\ turn' = IF turn[t] \in {"running", "deferred"}
               THEN [turn EXCEPT ![t] = "interrupted"] ELSE turn
    /\ ReleaseIf(t)
    /\ UNCHANGED <<regEpoch, nextTurn, create, slot, queue, stopEpoch, latch, interrupted,
                   userStops, ownerInts, ownerGone, parked, listExists, listGen, lock,
                   pendingEnd, intr, ustop, m>>

\* WTM interruptWorkspaceTurn 3658-3722 (inside the settlement lock, sync after
\* the record write): bump + latch, release the registration.
OwnerInterrupt(t) ==
    /\ intr.pc = "idle"
    /\ ownerInts < MaxOwnerInts
    /\ turn[t] \in {"reserved", "running", "deferred"}
    /\ turn' = [turn EXCEPT ![t] = "interrupted"]
    /\ stopEpoch' = stopEpoch + 1                              \* WTM 3698
    /\ latch' = latch + 1                                      \* WTM 3699
    /\ ownerInts' = ownerInts + 1
    /\ intr' = [pc |-> "stopping", t |-> t]
    /\ ReleaseIf(t)                                            \* WTM 3709-3715
    /\ UNCHANGED <<regEpoch, nextTurn, create, slot, queue, interrupted, userStops,
                   ownerGone, parked, listExists, listGen, lock, pendingEnd, pendingAbort,
                   ustop, m>>

\* WTM 3742-3756: `await stopStream`, then the latch release (TS 2587-2600).
OwnerInterruptDone ==
    /\ intr.pc = "stopping"
    /\ slot' = IF slot.k = "stream" /\ SlotTurn = intr.t THEN IdleSlot ELSE slot
    /\ latch' = latch - 1
    /\ fl' = IF latch = 1 THEN Sched(listExists) ELSE fl
    /\ intr' = [pc |-> "idle", t |-> 0]
    /\ UNCHANGED <<reg, regEpoch, turn, nextTurn, create, queue, stopEpoch, interrupted,
                   userStops, ownerInts, ownerGone, parked, listExists, listGen, lock,
                   pendingEnd, pendingAbort, ustop, m>>

\* Owner withdrawn: stopped, consent revoked, runtime changed or target archived
\* (#5261). Only a gate reads it.
OwnerWithdraw ==
    /\ AllowWithdraw
    /\ ~ownerGone
    /\ ownerGone' = TRUE
    /\ UNCHANGED <<reg, regEpoch, turn, nextTurn, create, slot, queue, stopEpoch, latch,
                   interrupted, userStops, ownerInts, parked, listExists, listGen, fl, lock,
                   pendingEnd, pendingAbort, intr, ustop, m>>

-----------------------------------------------------------------------------
(* User hard Stop on the target: WS interruptStream 15792-15818 *)

\* resetAutoResumeCount, markParentWorkspaceInterrupted (TS 15943-15958: bump,
\* suppress, DROP the parked list), latchHardInterruptCascade (TS 15973-15976).
UserStop ==
    /\ ustop = "idle"
    /\ userStops < MaxUserStops
    /\ interrupted' = TRUE
    /\ stopEpoch' = stopEpoch + 1
    /\ latch' = latch + 1
    /\ userStops' = userStops + 1
    /\ ustop' = "stopping"
    /\ parked' = <<>>
    /\ listExists' = FALSE
    /\ listGen' = IF listExists THEN listGen + 1 ELSE listGen
    /\ m' = [i \in Msgs |->
               IF \E k \in 1..Len(parked) : parked[k].m = i
               THEN [m[i] EXCEPT !.out = "dropped", !.why = "user_stop"]
               ELSE m[i]]
    /\ UNCHANGED <<reg, regEpoch, turn, nextTurn, create, slot, queue, ownerInts,
                   ownerGone, fl, lock, pendingEnd, pendingAbort, intr>>

\* The session abort (stream-abort event queued for TaskService) and the latch
\* release in interruptStream's finally.
UserStopDone ==
    /\ ustop = "stopping"
    /\ LET t == SlotTurn IN
       /\ pendingAbort' = IF slot.k = "stream" /\ t # 0 THEN pendingAbort \cup {t} ELSE pendingAbort
       /\ slot' = IF slot.k = "stream" THEN IdleSlot ELSE slot
    /\ latch' = latch - 1
    /\ fl' = IF latch = 1 THEN Sched(listExists) ELSE fl
    /\ ustop' = "idle"
    /\ UNCHANGED <<reg, regEpoch, turn, nextTurn, create, queue, stopEpoch, interrupted,
                   userStops, ownerInts, ownerGone, parked, listExists, listGen, lock,
                   pendingEnd, intr, m>>

\* The user's next real send clears the suppression (TS 15936-15940).
UserResume ==
    /\ interrupted
    /\ ustop = "idle"
    /\ interrupted' = FALSE
    /\ UNCHANGED <<reg, regEpoch, turn, nextTurn, create, slot, queue, stopEpoch, latch,
                   userStops, ownerInts, ownerGone, parked, listExists, listGen, fl, lock,
                   pendingEnd, pendingAbort, intr, ustop, m>>

-----------------------------------------------------------------------------
(* Fix5261 (#5308): reconcile after a withdrawn continuation *)

\* TS scheduleWithdrawnWorkspaceTurnContinuationReconcile -> WTM
\* reconcileWithdrawnWorkspaceTurnContinuation -> settleStaleWorkspaceTurn, one await-free
\* step: the sweep decides once its admission exclusion and stream-start lock are held, so no
\* stream starts or ends meanwhile. The reconcile first waits for the target to be idle with an
\* empty queue (waitForIdleAndNoQueuedMessages), then takes the target's event lock
\* (SettleUnderLock). The lock is FIFO, and a stream end/abort/error handler is queued on it in
\* the event's own tick, before the session reads idle, so every handler of an ended stream runs
\* first (pendingEnd and pendingAbort are empty). Only a turn whose stream end deferred to a
\* continuation is settled; any other turn is left alone. With the session idle and the queue
\* empty nothing is pending, so the reconcile's "retry" (streaming or queued/preparing work) is
\* never taken here: the reconcile is done after this step. The checked invariants do not compare
\* turn results, so neither the idle wait nor the handler ordering is load-bearing for them (both
\* removed, MC_Search stays clean); the regression test "the settlement does not overtake a newer
\* correlated stream end" covers the ordering. Fix5261 itself is (off: NoOrphanedTurn fails).
WithdrawSettle(t) ==
    /\ wsettle[t] = "pending"
    /\ Idle /\ queue = <<>>
    /\ SettleUnderLock => (lock = 0 /\ pendingEnd = {} /\ pendingAbort = {})
    /\ IF turn[t] = "deferred"
       THEN /\ turn' = [turn EXCEPT ![t] = "done"]
            /\ ReleaseIf(t)
       ELSE UNCHANGED <<turn, reg, fl>>
    /\ wsettle' = [wsettle EXCEPT ![t] = "none"]
    /\ UNCHANGED <<regEpoch, nextTurn, create, slot, queue, stopEpoch, latch, interrupted,
                   userStops, ownerInts, ownerGone, parked, listExists, listGen, lock,
                   pendingEnd, pendingAbort, intr, ustop, m>>

-----------------------------------------------------------------------------
(* TS flushParkedPeerSends 2527-2572 (one flush at a time per target) *)

FlushBegin ==
    /\ fl.sched
    /\ ~fl.run
    /\ fl' = [sched |-> FALSE, run |-> TRUE, started |-> FALSE, cur |-> 0, gen |-> listGen]
    /\ UNCHANGED <<reg, regEpoch, turn, nextTurn, create, slot, queue, stopEpoch, latch,
                   interrupted, userStops, ownerInts, ownerGone, parked, listExists, listGen,
                   lock, pendingEnd, pendingAbort, intr, ustop, m>>

\* One loop iteration up to `await this.sendTreeMessage(spec)` (TS 2533-2560).
FlushStep ==
    /\ fl.run
    /\ fl.cur = 0
    /\ IF ~listExists \/ fl.gen # listGen                     \* TS 2533 list identity
          \/ reg.t # None \/ latch > 0                        \* TS 2535-2540
       THEN /\ fl' = [fl EXCEPT !.run = FALSE]
            /\ UNCHANGED <<parked, listExists, listGen, m>>
       ELSE IF parked = <<>>                                   \* TS 2551-2555
       THEN /\ fl' = [fl EXCEPT !.run = FALSE]
            /\ listExists' = FALSE
            /\ listGen' = listGen + 1
            /\ UNCHANGED <<parked, m>>
       ELSE LET based == IF fl.started THEN parked            \* TS 2541-2550 rebaseline once
                         ELSE [k \in 1..Len(parked) |-> [parked[k] EXCEPT !.sBase = stopEpoch]]
                h == Head(based)
            IN /\ parked' = Tail(based)
               /\ fl' = [fl EXCEPT !.started = TRUE, !.cur = h.m]
               /\ m' = [m EXCEPT ![h.m] = [@ EXCEPT !.pc = "retry", !.retry = TRUE,
                           !.rEpoch = h.rEpoch, !.sBase = h.sBase, !.corr = 0,
                           !.corrDone = FALSE, !.refusal = "none"]]
               /\ UNCHANGED <<listExists, listGen>>
    /\ UNCHANGED <<reg, regEpoch, turn, nextTurn, create, slot, queue, stopEpoch, latch,
                   interrupted, userStops, ownerInts, ownerGone, lock, pendingEnd,
                   pendingAbort, intr, ustop>>

\* sendTreeMessage returned (delivered, queued in the session, or dropped).
FlushAwait ==
    /\ fl.run
    /\ fl.cur # 0
    /\ m[fl.cur].pc \in {"done", "queued"}
    /\ fl' = [fl EXCEPT !.cur = 0]
    /\ UNCHANGED <<reg, regEpoch, turn, nextTurn, create, slot, queue, stopEpoch, latch,
                   interrupted, userStops, ownerInts, ownerGone, parked, listExists, listGen,
                   lock, pendingEnd, pendingAbort, intr, ustop, m>>

-----------------------------------------------------------------------------

\* Actions that leave wsettle unchanged.
NextBase ==
    \/ \E i \in Msgs : Enter(i) \/ Corr(i) \/ Gate1(i) \/ WsGate(i) \/ Gate2(i)
    \/ CreateDecide
    \/ StreamEnd
    \/ \E t \in Turns : CreateRegister(t) \/ CreateLaunch(t)
    \/ \E t \in Turns : Finalize(t) \/ AbortFinalize(t) \/ OwnerInterrupt(t)
    \/ OwnerInterruptDone \/ OwnerWithdraw
    \/ UserStop \/ UserStopDone \/ UserResume
    \/ FlushBegin \/ FlushStep \/ FlushAwait

Next ==
    \/ NextBase /\ UNCHANGED wsettle
    \/ \E i \in Msgs : Rollback(i)
    \/ Dequeue
    \/ \E t \in Turns : WithdrawSettle(t)

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* Properties *)

TypeOK ==
    /\ reg.t \in 0..NT
    /\ lock \in 0..NM
    /\ latch \in 0..2
    /\ \A i \in Msgs : m[i].deliveries \in 0..1

\* No duplicate delivery.
NoDuplicate == \A i \in Msgs : m[i].deliveries <= 1

\* A message that waited for a delegated turn is never delivered after a later
\* registration (#5271 design; #5277 is a counterexample).
NoDeliveryIntoReplacement ==
    \A i \in Msgs : (m[i].waited /\ m[i].out = "delivered") => m[i].delEpoch = m[i].met

\* A user Stop refuses every agent message not admitted before it
\* (markParentWorkspaceInterrupted, TS 15950-15953).
UserStopRespected ==
    \A i \in Msgs : m[i].out = "delivered" => m[i].delUstops = m[i].ustopAt

\* An owner interrupt refuses sends admitted before it, except messages that
\* waited for the turn on purpose (TS 2541-2549).
OwnerStopRespected ==
    \A i \in Msgs : (m[i].out = "delivered" /\ ~m[i].waited) => m[i].delOints = m[i].ointAt

\* A non-owner message never carries the owner's correlation into a turn (TS 10107-10109).
NonOwnerNeverCorrelated ==
    \A i \in Msgs : (~IsOwner(i) /\ m[i].out = "delivered") => m[i].corr = 0

\* #5261: no delegated turn stays running with nothing left to settle it.
Orphaned(t) ==
    /\ turn[t] = "deferred"
    /\ ~ContinuationPending(t)
    /\ t \notin pendingEnd
    /\ t \notin pendingAbort
    /\ ~\E i \in Msgs : m[i].pc \in {"persist", "qpersist"} /\ m[i].corr = t
    /\ wsettle[t] = "none"
NoOrphanedTurn == \A t \in Turns : ~Orphaned(t)

\* No parked message is stranded: something will flush it.
NoStrandedPark ==
    (listExists /\ parked # <<>>) =>
        (fl.sched \/ fl.run \/ reg.t # None \/ latch > 0)

\* Every accepted-as-queued message ends delivered or dropped with a reason
\* once the system is quiescent.
Quiescent ==
    /\ \A i \in Msgs : m[i].pc \in {"unsent", "done"}
    /\ ~fl.run /\ ~fl.sched /\ queue = <<>> /\ slot.k = "idle"
    /\ pendingEnd = {} /\ pendingAbort = {} /\ intr.pc = "idle" /\ ustop = "idle"
    /\ \A t \in Turns : create[t].pc \in {"idle", "done"} /\ wsettle[t] = "none"
    /\ lock = 0
NoSilentLoss ==
    Quiescent => \A i \in Msgs :
        m[i].told \in {"queued", "accepted"} => m[i].out \in {"delivered", "dropped"}
=============================================================================
