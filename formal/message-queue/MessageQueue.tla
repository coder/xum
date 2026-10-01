---------------------------- MODULE MessageQueue ----------------------------
(***************************************************************************)
(* Queue + stream interplay of src/node/services/messageQueue.ts and its    *)
(* consumer src/node/services/agentSession.ts, with the send entry point in *)
(* src/node/services/workspaceService.ts.                                    *)
(*                                                                         *)
(* Every action is one synchronous segment (no await inside). Abstractions: *)
(* - Message content, options, files and callbacks are dropped; a message  *)
(*   is its send index plus the attributes that steer queue placement.     *)
(* - Dispatch is atomic: the PREPARING window, where observers may reorder *)
(*   the head (agentSession.ts:10622-10624), is not modelled.              *)
(* - resolveDispatch "hold" (agentSession.ts:10566-10567) is one pending    *)
(*   report decision: while it is pending, entries flagged `holdable`      *)
(*   (task-attempt tokens) hold at the head; its resolution re-runs the    *)
(*   idle drain (comment at agentSession.ts:10559-10565).                  *)
(* - The stream is abstract: at each tool boundary it may be cut when the  *)
(*   next dispatchable entry is tool-end (agentSession.ts:9963-9966 via    *)
(*   StreamManager's stop condition), or the turn may end naturally.       *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
  N,              \* number of sends
  AllowHold,      \* a pending report decision may hold holdable heads
  MaxDecisions,   \* report decisions per behavior (a task reports finitely often)
  AllowWithdraw,  \* cancel signals may fire on withdrawable entries
  AllowRemove,    \* removeWorkspaceTurn / removeByDedupeKeyPrefix / removeEntry
  AllowReorder,   \* setVisibleQueueDispatchMode / prioritizeNextUserEntry
  AllowStop,      \* one Stop cascade (latch, one queue clear, release) may run
  Mutant          \* "none" | "noDequeue" | "decisionNoDrain" | "directSend" | "trailingRun"
                  \* | "noEnqueueBarrier" | "clearDrops"

Modes == {"tool", "turn"}
\* Send shapes that matter for placement. "plain" batches (messageQueue.ts:747-759);
\* "sealed" starts and seals its own entry (:717-738); "promoted" is a sealed tool-end
\* add with promoteAheadOfHiddenTurnEnd (taskService.ts agent_report and the busy-owner
\* attention wake; both carry removable dedupe keys and admission probes, so sealed).
Kinds == {"plain", "sealed", "promoted"}

Attrs ==
  {a \in [user : BOOLEAN, mode : Modes, kind : Kinds, withdrawable : BOOLEAN,
          holdable : BOOLEAN] :
     /\ a.kind = "promoted" => (~a.user /\ a.mode = "tool")
     \* cancel signals and task-attempt tokens seal (messageQueue.ts:707-738)
     /\ (a.withdrawable \/ a.holdable) => a.kind # "plain"
     /\ a.withdrawable => ~a.holdable}

VARIABLES
  sent,       \* number of sends so far
  attr,       \* attr[m]: attributes of message m (valid for m <= sent)
  entries,    \* messageQueue.ts:324 `entries`
  phase,      \* "idle" | "streaming" | "draining" (stream ended; its drain chain is running)
  dispatched, \* messages in the order their turns started
  removed,    \* messages removed or withdrawn without a turn
  drainPending, \* a sendQueuedMessages call is due
  decision,   \* a report decision is pending (resolveDispatch may answer "hold")
  decisions,  \* report decisions started so far
  owed,       \* a stream was cut for the queue and no successor turn started yet
  stopLatched, \* TaskService.isWorkspaceStopInProgress
  stopCleared, \* the latched cascade already ran its queue clear (Phase B)
  stops,      \* Stop cascades begun so far
  kept,       \* user messages handed back (held input) or refused visibly: not run, not lost
  stopped     \* messages admitted before or during a Stop: they must never start a turn

stopVars == <<stopLatched, stopCleared, stops, kept, stopped>>
vars == <<sent, attr, entries, phase, dispatched, removed, drainPending, decision, decisions,
          owed, stopVars>>

NoAttr == [user |-> FALSE, mode |-> "turn", kind |-> "plain", withdrawable |-> FALSE,
           holdable |-> FALSE]

Init ==
  /\ sent = 0
  /\ attr = [m \in 1..N |-> NoAttr]
  /\ entries = <<>>
  /\ phase = "idle"
  /\ dispatched = <<>>
  /\ removed = {}
  /\ drainPending = FALSE
  /\ decision = FALSE
  /\ decisions = 0
  /\ owed = FALSE
  /\ stopLatched = FALSE
  /\ stopCleared = FALSE
  /\ stops = 0
  /\ kept = {}
  /\ stopped = {}

Range(s) == {s[i] : i \in 1..Len(s)}
Flatten(es) == IF es = <<>> THEN <<>> ELSE
  LET F[i \in 0..Len(es)] == IF i = 0 THEN <<>> ELSE F[i - 1] \o es[i].msgs IN F[Len(es)]
Queued == Range(Flatten(entries))

Live(e) == ~e.aborted
Holds(e) == e.holdable /\ decision

\* messageQueue.ts:392-398 nextDispatchableEntry: first entry whose cancel signal has not fired.
NextIdx == IF \E i \in 1..Len(entries) : Live(entries[i])
             THEN CHOOSE i \in 1..Len(entries) :
                    Live(entries[i]) /\ \A j \in 1..(i - 1) : ~Live(entries[j])
             ELSE 0

\* Mutant "trailingRun": the pre-fix rule, which stopped at the first user-authored or tool-end
\* predecessor (finding F1).
RECURSIVE RunStart(_, _)
RunStart(es, k) ==
  IF k = 0 THEN 0
  ELSE IF es[k].user \/ es[k].mode # "turn" THEN k
  ELSE RunStart(es, k - 1)
\* messageQueue.ts promotedToolEndInsertIndex: entries kept ahead of a promoted add. It goes before
\* the first live hidden turn-end entry after the last user-authored entry, else at the end.
RECURSIVE UserFloor(_, _)
UserFloor(es, k) == IF k = 0 \/ es[k].user THEN k ELSE UserFloor(es, k - 1)
PromoteAt(es) ==
  LET f == UserFloor(es, Len(es))
      blocking == {i \in (f + 1)..Len(es) : es[i].mode = "turn" /\ Live(es[i])}
  IN IF blocking = {} THEN Len(es)
     ELSE (CHOOSE i \in blocking : \A j \in blocking : i <= j) - 1
InsertAt(s, i, x) == SubSeq(s, 1, i) \o <<x>> \o SubSeq(s, i + 1, Len(s))

NewEntry(m, a) ==
  [msgs |-> <<m>>, user |-> a.user, mode |-> a.mode, sealed |-> a.kind # "plain",
   aborted |-> FALSE, withdrawable |-> a.withdrawable, holdable |-> a.holdable,
   promoted |-> a.kind = "promoted"]

\* messageQueue.ts addInternal (+ promoteAheadOfHiddenTurnEndPredecessors).
Enqueue(m, a) ==
  LET tail == entries[Len(entries)]
      batch == /\ entries # <<>>
               /\ ~tail.sealed
               /\ a.kind = "plain"                 \* incomingStartsNewEntry is false
               /\ tail.user = a.user               \* :736
  IN IF batch
       THEN entries' = [entries EXCEPT ![Len(entries)] =
                          [@ EXCEPT !.msgs = Append(@, m),
                                    !.mode = IF a.mode = "tool" THEN "tool" ELSE @]]  \* :754-758
       ELSE LET e == NewEntry(m, a)
            IN IF a.kind = "promoted"
                 THEN entries' = InsertAt(entries,
                                          IF Mutant = "trailingRun"
                                            THEN RunStart(entries, Len(entries))
                                            ELSE PromoteAt(entries), e)
                 ELSE entries' = Append(entries, e)

\* workspaceService.ts sendMessage `shouldQueue`: queue while the session is busy or still holds
\* dispatchable queued work (hasQueuedMessages); an idle session with queued work then drains
\* (drainQueuedMessagesIfIdle). Otherwise the send starts its turn directly
\* (AgentSession.sendMessage). Mutant "directSend": the pre-fix rule, which queued only while
\* busy (finding F2).
\* Send is the queue-or-send decision; the send passed the entry barrier earlier, so a decision
\* under the stop latch is a send admitted before the Stop. The latch is re-checked at the
\* enqueue point, and the direct path's session admission refuses too: the caller keeps the
\* refused message. Mutant "noEnqueueBarrier": the queue path does not re-check the latch.
Send ==
  /\ sent < N
  /\ \E a \in Attrs :
       LET m == sent + 1
           direct == phase = "idle" /\ (NextIdx = 0 \/ Mutant = "directSend")
       IN
       /\ sent' = m
       /\ attr' = [attr EXCEPT ![m] = a]
       /\ stopped' = IF stopLatched THEN stopped \cup {m} ELSE stopped
       /\ IF stopLatched /\ (direct \/ Mutant # "noEnqueueBarrier")
            THEN /\ IF a.user THEN kept' = kept \cup {m} /\ UNCHANGED removed
                               ELSE removed' = removed \cup {m} /\ UNCHANGED kept
                 /\ UNCHANGED <<entries, dispatched, phase, owed, drainPending>>
            ELSE IF direct
            THEN /\ dispatched' = Append(dispatched, m)
                 /\ phase' = "streaming"
                 /\ owed' = FALSE
                 /\ UNCHANGED <<entries, drainPending, removed, kept>>
            ELSE /\ Enqueue(m, a)
                 /\ drainPending' = (drainPending \/ phase = "idle")
                 /\ UNCHANGED <<dispatched, phase, owed, removed, kept>>
       /\ UNCHANGED <<decision, decisions, stopLatched, stopCleared, stops>>

\* A tool boundary where the stop condition sees a tool-end next entry: the stream ends and
\* its stream-end drains the queue (agentSession.ts:9150 sendQueuedMessages("terminal")).
Cut ==
  /\ phase = "streaming"
  /\ NextIdx # 0
  /\ entries[NextIdx].mode = "tool"
  /\ phase' = "draining"
  /\ owed' = TRUE
  /\ drainPending' = TRUE
  /\ UNCHANGED <<sent, attr, entries, dispatched, removed, decision, decisions>>
  /\ UNCHANGED stopVars

TurnEnd ==
  /\ phase = "streaming"
  /\ phase' = "draining"
  /\ drainPending' = TRUE
  /\ UNCHANGED <<sent, attr, entries, dispatched, removed, decision, decisions, owed>>
  /\ UNCHANGED stopVars

\* agentSession.ts:10540-10686 sendQueuedMessages (closing, edit and mid-stream compaction
\* gates are not modelled). The session stays busy ("draining") until the drain chain either
\* starts a turn or finds nothing to start.
Drain ==
  /\ drainPending
  /\ phase \in {"idle", "draining"}
  /\ ~stopLatched                                           \* stop-cascade barrier
  /\ UNCHANGED stopVars
  /\ IF entries = <<>>
       THEN /\ drainPending' = FALSE                           \* :10555-10557
            /\ phase' = "idle"
            /\ UNCHANGED <<entries, dispatched, removed, owed>>
       ELSE LET h == Head(entries) IN
            IF Holds(h)
              THEN /\ drainPending' = FALSE                     \* :10566-10567 hold
                   /\ phase' = "idle"
                   /\ UNCHANGED <<entries, dispatched, removed, owed>>
            ELSE IF h.aborted
              \* A withdrawn head is dequeued and dispatched as a no-op (cancelBeforeAcceptance
              \* inside the admitted attempt); completePreparation drains again once the attempt
              \* settles (:3863-3869).
              THEN /\ entries' = Tail(entries)
                   /\ removed' = removed \cup Range(h.msgs)
                   /\ phase' = "draining"
                   /\ UNCHANGED <<drainPending, dispatched, owed>>
            ELSE /\ entries' = IF Mutant = "noDequeue" THEN entries ELSE Tail(entries)  \* :10626
                 /\ dispatched' = dispatched \o h.msgs
                 /\ phase' = "streaming"
                 /\ owed' = FALSE
                 /\ drainPending' = FALSE
                 /\ UNCHANGED removed
  /\ UNCHANGED <<sent, attr, decision, decisions>>

StartDecision ==
  /\ AllowHold
  /\ ~decision
  /\ decisions < MaxDecisions
  /\ decision' = TRUE
  /\ decisions' = decisions + 1
  /\ UNCHANGED <<sent, attr, entries, phase, dispatched, removed, drainPending, owed>>
  /\ UNCHANGED stopVars

\* TaskService resolves the report decision and re-runs the idle drain.
ResolveDecision ==
  /\ decision
  /\ decision' = FALSE
  /\ drainPending' = IF Mutant = "decisionNoDrain" THEN drainPending ELSE TRUE
  /\ UNCHANGED <<sent, attr, entries, phase, dispatched, removed, decisions, owed>>
  /\ UNCHANGED stopVars

\* A cancel signal fires (e.g. the bash-monitor reconciler withdraws a wake). No drain.
Withdraw ==
  /\ AllowWithdraw
  /\ \E i \in 1..Len(entries) :
       /\ entries[i].withdrawable /\ ~entries[i].aborted
       /\ entries' = [entries EXCEPT ![i].aborted = TRUE]
  /\ UNCHANGED <<sent, attr, phase, dispatched, removed, drainPending, decision, decisions, owed>>
  /\ UNCHANGED stopVars

\* agentSession.ts:9780-9835 removal of a sealed hidden entry; it publishes the queue change
\* but does not drain.
Remove ==
  /\ AllowRemove
  /\ \E i \in 1..Len(entries) :
       /\ entries[i].sealed /\ ~entries[i].user
       /\ removed' = removed \cup Range(entries[i].msgs)
       /\ entries' = SubSeq(entries, 1, i - 1) \o SubSeq(entries, i + 1, Len(entries))
  /\ UNCHANGED <<sent, attr, phase, dispatched, drainPending, decision, decisions, owed>>
  /\ UNCHANGED stopVars

UserIdx == {i \in 1..Len(entries) : entries[i].user}
Seqify(S) == \* the elements of a finite set of indices, ascending
  LET F[k \in 0..Cardinality(S)] ==
        IF k = 0 THEN <<>>
        ELSE LET prev == F[k - 1]
                 rest == S \ Range(prev)
             IN Append(prev, CHOOSE x \in rest : \A y \in rest : x <= y)
  IN F[Cardinality(S)]

\* messageQueue.ts:605-625 setVisibleQueueDispatchMode: user entries take the mode and move
\* to the head, keeping their order.
SetVisibleMode ==
  /\ AllowReorder
  /\ UserIdx # {}
  /\ \E mode \in Modes :
       LET us == Seqify(UserIdx)
           hs == Seqify((1..Len(entries)) \ UserIdx)
       IN entries' = [k \in 1..Len(us) |-> [entries[us[k]] EXCEPT !.mode = mode]]
                     \o [k \in 1..Len(hs) |-> entries[hs[k]]]
  /\ UNCHANGED <<sent, attr, phase, dispatched, removed, drainPending, decision, decisions, owed>>
  /\ UNCHANGED stopVars

\* messageQueue.ts:1137-1148 prioritizeNextUserEntry (Send now), then sendQueuedMessages.
SendNow ==
  /\ AllowReorder
  /\ UserIdx # {}
  /\ LET i == Seqify(UserIdx)[1]
     IN entries' = <<entries[i]>> \o SubSeq(entries, 1, i - 1)
                   \o SubSeq(entries, i + 1, Len(entries))
  /\ drainPending' = TRUE
  /\ UNCHANGED <<sent, attr, phase, dispatched, removed, decision, decisions, owed>>
  /\ UNCHANGED stopVars

\* TaskService beginWorkspaceStop (Phase A): bump the epoch and latch. The stopped stream
\* ends; its stream-end drain waits for the latch.
BeginStop ==
  /\ AllowStop
  /\ stops = 0
  /\ stopLatched' = TRUE
  /\ stops' = 1
  /\ stopped' = stopped \cup Queued
  /\ IF phase = "streaming"
       THEN phase' = "draining" /\ drainPending' = TRUE
       ELSE UNCHANGED <<phase, drainPending>>
  /\ UNCHANGED <<sent, attr, entries, dispatched, removed, decision, decisions, owed,
                 stopCleared, kept>>

\* runWorkspaceStopCleanup (Phase B), once per latch: the queue is emptied; user-authored
\* messages are handed back as held input (clearQueue preserveUserInput), background ones
\* canceled. Mutant "clearDrops": the plain clear, which discards user messages too.
StopClear ==
  /\ stopLatched /\ ~stopCleared
  /\ LET keep == IF Mutant = "clearDrops" THEN {}
              ELSE {m \in Queued : attr[m].user /\ ~attr[m].withdrawable}
     IN /\ kept' = kept \cup keep
        /\ removed' = removed \cup (Queued \ keep)
  /\ entries' = <<>>
  /\ stopCleared' = TRUE
  /\ UNCHANGED <<sent, attr, phase, dispatched, drainPending, decision, decisions, owed,
                 stopLatched, stops, stopped>>

\* Phase C: the latch drops only after the cleanup ran.
EndStop ==
  /\ stopLatched /\ stopCleared
  /\ stopLatched' = FALSE
  /\ stopCleared' = FALSE
  /\ UNCHANGED <<sent, attr, entries, phase, dispatched, removed, drainPending, decision,
                 decisions, owed, stops, kept, stopped>>

Done == sent = N /\ entries = <<>> /\ phase = "idle" /\ ~drainPending /\ ~decision
        /\ ~stopLatched

Next ==
  \/ Send \/ Cut \/ TurnEnd \/ Drain \/ StartDecision \/ ResolveDecision
  \/ Withdraw \/ Remove \/ SetVisibleMode \/ SendNow
  \/ BeginStop \/ StopClear \/ EndStop
  \/ (Done /\ UNCHANGED vars)

Spec == Init /\ [][Next]_vars /\ WF_vars(Drain) /\ WF_vars(ResolveDecision) /\ WF_vars(TurnEnd)

-----------------------------------------------------------------------------
Sent == 1..sent

\* Every message is in exactly one place, and no turn starts twice for it.
NoLossNoDup ==
  /\ Len(dispatched) = Cardinality(Range(dispatched))
  /\ Len(Flatten(entries)) = Cardinality(Queued)
  /\ Range(dispatched) \cup Queued \cup removed \cup kept = Sent
  /\ Range(dispatched) \cap Queued = {}
  /\ Range(dispatched) \cap removed = {}
  /\ Queued \cap removed = {}
  /\ kept \cap (Range(dispatched) \cup Queued \cup removed) = {}

\* User-authored messages start turns in the order they were sent.
UserOrder ==
  \A i, j \in 1..Len(dispatched) :
    (i < j /\ attr[dispatched[i]].user /\ attr[dispatched[j]].user) =>
      dispatched[i] < dispatched[j]

\* No stranded queue: an idle session with queued work always has a drain coming, or waits
\* for the pending report decision (whose resolution drains).
NoStrandedQueue == (phase = "idle" /\ entries # <<>> /\ ~drainPending) => decision

\* A promoted tool-end entry is never kept behind a live hidden turn-end entry, except behind a
\* user-authored entry, withdrawn or not: promotion never passes one (the user's choice governs,
\* messageQueue.ts:170-176).
PromotedNotBlockedByHidden ==
  \A j \in 1..Len(entries) :
    (entries[j].promoted /\ Live(entries[j])) =>
      \A i \in 1..(j - 1) :
        (Live(entries[i]) /\ ~entries[i].user /\ entries[i].mode = "turn") =>
          \E k \in (i + 1)..(j - 1) : entries[k].user

\* A user-authored message is never discarded: it starts a turn, stays queued, or is handed
\* back / refused visibly (withdrawable messages are background-only in the code).
UserInputNeverLost ==
  \A m \in Sent : (attr[m].user /\ ~attr[m].withdrawable) => m \notin removed

\* Input admitted before a Stop (queued when it began, or deciding under its latch) never
\* starts a turn.
NoRunAfterStop == Range(dispatched) \cap stopped = {}

\* A stream cut for a queued entry is continued by a successor turn.
QueueCutPreserved == (phase = "idle" /\ entries = <<>> /\ ~drainPending) => ~owed

\* Every queued message eventually starts a turn or is removed.
EventuallyHandled == \A m \in 1..N : (m \in Queued) ~> (m \notin Queued)
=============================================================================
