-------------------------- MODULE AsyncSemaphore --------------------------
(***************************************************************************)
(* Model of src/node/utils/concurrency/asyncSemaphore.ts.                  *)
(*                                                                         *)
(* Same execution model as AsyncMutex.tla: each action is one await-free   *)
(* segment. releaseSlot() hands its slot straight to the first waiter      *)
(* (`active` unchanged); the waiter's continuation runs in a later         *)
(* microtask ("woken" state), during which it already owns the slot. A     *)
(* throw in the critical section is the same Release: callers release in   *)
(* `finally`.                                                              *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
  Procs,
  Rounds,
  Limit,              \* constructor `limit` (asyncSemaphore.ts:17)
  AllowDoubleRelease, \* a contender may call release() on an already-released slot
  Mutant              \* "none" = faithful; "noWake" = releaseSlot() frees without handing off

VARIABLES active, queue, ready, pc, rounds, ticket, nextTicket, stale

vars == <<active, queue, ready, pc, rounds, ticket, nextTicket, stale>>

Holders == {p \in Procs : pc[p] = "holding"}
\* A woken waiter already owns its slot; only its continuation is pending.
Owners == {p \in Procs : pc[p] \in {"woken", "holding"}}
Waiting == {p \in Procs : pc[p] \in {"parked", "woken"}}
QueueSet == {queue[i] : i \in 1..Len(queue)}

Init ==
  /\ active = 0
  /\ queue = <<>>
  /\ ready = <<>>
  /\ pc = [p \in Procs |-> "idle"]
  /\ rounds = [p \in Procs |-> 0]
  /\ ticket = [p \in Procs |-> 0]
  /\ nextTicket = 1
  /\ stale = [p \in Procs |-> FALSE]

\* asyncSemaphore.ts:22-31 acquire(): the fast-path check runs in the caller's segment.
CallAcquire(p) ==
  /\ pc[p] = "idle"
  /\ rounds[p] < Rounds
  /\ rounds' = [rounds EXCEPT ![p] = @ + 1]
  /\ ticket' = [ticket EXCEPT ![p] = nextTicket]
  /\ nextTicket' = nextTicket + 1
  /\ IF active < Limit
       THEN /\ active' = active + 1                    \* :24
            /\ pc' = [pc EXCEPT ![p] = "holding"]
            /\ queue' = queue
       ELSE /\ queue' = Append(queue, p)               \* :30 push resolver, await
            /\ pc' = [pc EXCEPT ![p] = "parked"]
            /\ active' = active
  /\ UNCHANGED <<ready, stale>>

\* asyncSemaphore.ts:30, continuation after `await`: it was handed a slot, so there is
\* nothing to re-check.
Resume(q) ==
  /\ ready # <<>>
  /\ q = Head(ready)       \* continuations run in the order their promises resolved
  /\ ready' = Tail(ready)
  /\ pc' = [pc EXCEPT ![q] = "holding"]
  /\ UNCHANGED <<active, queue, rounds, ticket, nextTicket, stale>>

\* asyncSemaphore.ts:59-63 AsyncSemaphoreSlot.release() -> :37-45 releaseSlot().
\* Callers call it in `finally`, so this also covers a throw in the critical section.
\* (assert :38 holds: active > 0.)
Release(p) ==
  /\ pc[p] = "holding"
  /\ IF queue # <<>> /\ Mutant # "noWake"
       THEN /\ queue' = Tail(queue)                    \* :39-41 hand the slot over
            /\ ready' = Append(ready, Head(queue))
            /\ pc' = [pc EXCEPT ![Head(queue)] = "woken", ![p] = "idle"]
            /\ active' = active
       ELSE /\ queue' = queue
            /\ ready' = ready
            /\ pc' = [pc EXCEPT ![p] = "idle"]
            /\ active' = active - 1                    \* :43
  /\ stale' = [stale EXCEPT ![p] = AllowDoubleRelease]
  /\ UNCHANGED <<rounds, ticket, nextTicket>>

\* asyncSemaphore.ts:60: a second release() of the same slot throws before touching the
\* semaphore, so the only effect is dropping the stale handle.
StaleRelease(p) ==
  /\ stale[p]
  /\ stale' = [stale EXCEPT ![p] = FALSE]
  /\ UNCHANGED <<active, queue, ready, pc, rounds, ticket, nextTicket>>

Terminated == \A p \in Procs : pc[p] = "idle" /\ rounds[p] = Rounds

Next ==
  \/ \E p \in Procs : CallAcquire(p) \/ Resume(p) \/ Release(p) \/ StaleRelease(p)
  \/ (Terminated /\ UNCHANGED vars)

Fairness == \A p \in Procs : WF_vars(Release(p)) /\ WF_vars(Resume(p))

Spec == Init /\ [][Next]_vars /\ Fairness

-----------------------------------------------------------------------------
TypeOK ==
  /\ active \in 0..Limit
  /\ pc \in [Procs -> {"idle", "parked", "woken", "holding"}]

\* At most `limit` holders, and `active` counts exactly the slot owners.
WithinLimit == active <= Limit
ActiveIsHolders == active = Cardinality(Owners)

QueueIsParked ==
  /\ QueueSet = {p \in Procs : pc[p] = "parked"}
  /\ Len(queue) = Cardinality(QueueSet)

\* A free slot with a parked waiter implies a pending wakeup.
NoLostWakeup == (active < Limit /\ queue # <<>>) => ready # <<>>

ReadyIsWoken ==
  /\ {ready[i] : i \in 1..Len(ready)} = {p \in Procs : pc[p] = "woken"}
  /\ Len(ready) = Cardinality({ready[i] : i \in 1..Len(ready)})

\* asyncSemaphore.ts:6-7 promises "further acquirers wait FIFO".
FIFOAmongWaiters ==
  [][\A p \in Procs :
       (pc[p] = "woken" /\ pc'[p] = "holding") =>
         \A q \in Waiting \ {p} : ticket[p] < ticket[q]]_vars

\* A woken proc already owns its grant, so only parked procs can be barged past.
NoBarging ==
  [][\A p \in Procs : (pc[p] = "idle" /\ pc'[p] = "holding") => QueueSet = {}]_vars

WaiterProgress == \A p \in Procs : (pc[p] = "parked") ~> (pc[p] = "holding")
=============================================================================
