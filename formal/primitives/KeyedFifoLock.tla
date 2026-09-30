--------------------------- MODULE KeyedFifoLock ---------------------------
(***************************************************************************)
(* Model of src/node/services/workflows/keyedFifoLock.ts for one key.      *)
(*                                                                         *)
(* Keys are independent: each has its own `queues` entry and every closure *)
(* captures its key, so one key is enough.                                 *)
(*                                                                         *)
(* Each action is one await-free segment. `new Promise(executor)` runs the *)
(* executor synchronously, so acquire() queues its grant and arms its timer *)
(* in the caller's segment. The timer callback and a release() are both    *)
(* whole segments, so they never interleave inside each other: either the  *)
(* release runs grant() first (clearTimeout, keyedFifoLock.ts:35) or the   *)
(* timer runs first and splices the grant out (:40-44). Ownership passes   *)
(* at grant(); the waiter's own continuation runs later but touches        *)
(* nothing in the lock, so "granted" and "holding" are one state.          *)
(* The deadline is abstracted: a timer may fire at any point while armed   *)
(* (this includes deadlines already in the past, delay 0).                 *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
  Procs,
  Rounds,
  Mutant   \* "none" | "noSplice" (timer resolves null but keeps its grant queued)
           \*        | "noReleasedFlag" (a releaser runs its body every call)

VARIABLES
  held,       \* keyedFifoLock.ts:11 `queues.has(key)`
  waiters,    \* keyedFifoLock.ts:11 `queues.get(key)`: grant closures as <<proc, round>>
  pc,         \* "idle" | "waiting" | "holding"
  timer,      \* the proc's acquire timer is armed (:38)
  rounds,
  ticket,
  nextTicket,
  stale       \* proc still has an already-used releaser it may call again

vars == <<held, waiters, pc, timer, rounds, ticket, nextTicket, stale>>

Holders == {p \in Procs : pc[p] = "holding"}
Waiting == {p \in Procs : pc[p] = "waiting"}
WaiterSet == {waiters[i] : i \in 1..Len(waiters)}

RemoveAt(s, i) == SubSeq(s, 1, i - 1) \o SubSeq(s, i + 1, Len(s))

Init ==
  /\ held = FALSE
  /\ waiters = <<>>
  /\ pc = [p \in Procs |-> "idle"]
  /\ timer = [p \in Procs |-> FALSE]
  /\ rounds = [p \in Procs |-> 0]
  /\ ticket = [p \in Procs |-> 0]
  /\ nextTicket = 1
  /\ stale = [p \in Procs |-> FALSE]

StartRound(p) ==
  /\ pc[p] = "idle"
  /\ rounds[p] < Rounds
  /\ rounds' = [rounds EXCEPT ![p] = @ + 1]
  /\ ticket' = [ticket EXCEPT ![p] = nextTicket]
  /\ nextTicket' = nextTicket + 1

\* keyedFifoLock.ts:14-20 tryAcquire(): take only when nobody holds the key.
TryAcquire(p) ==
  /\ StartRound(p)
  /\ IF ~held
       THEN /\ held' = TRUE
            /\ pc' = [pc EXCEPT ![p] = "holding"]
       ELSE UNCHANGED <<held, pc>>
  /\ UNCHANGED <<waiters, timer, stale>>

\* keyedFifoLock.ts:26-51 acquire(): the immediate path (:27-30), or queue a grant
\* and arm the deadline timer (:33-49), all in the caller's segment.
CallAcquire(p) ==
  /\ StartRound(p)
  /\ IF ~held
       THEN /\ held' = TRUE
            /\ pc' = [pc EXCEPT ![p] = "holding"]
            /\ UNCHANGED <<waiters, timer>>
       ELSE /\ waiters' = Append(waiters, <<p, rounds[p] + 1>>)   \* :49
            /\ timer' = [timer EXCEPT ![p] = TRUE]                 \* :38
            /\ pc' = [pc EXCEPT ![p] = "waiting"]
            /\ held' = held
  /\ UNCHANGED stale

\* keyedFifoLock.ts:39-45 timer callback: splice our grant out and resolve null.
Timeout(p) ==
  /\ timer[p]
  /\ timer' = [timer EXCEPT ![p] = FALSE]
  /\ LET g == <<p, rounds[p]>>
     IN IF \E i \in 1..Len(waiters) : waiters[i] = g
          THEN LET i == CHOOSE j \in 1..Len(waiters) : waiters[j] = g
               IN /\ waiters' = IF Mutant = "noSplice" THEN waiters ELSE RemoveAt(waiters, i)
                  /\ pc' = [pc EXCEPT ![p] = "idle"]
          ELSE UNCHANGED <<waiters, pc>>   \* :41 indexOf === -1: already granted
  /\ UNCHANGED <<held, rounds, ticket, nextTicket, stale>>

\* keyedFifoLock.ts:61-72 releaser body: hand the key to the first grant (:67-69),
\* or delete the entry when nobody waits (:71). grant() (:34-37) clears the timer and
\* resolves; resolving a promise that already settled does nothing, so a grant whose
\* acquire already returned (only possible under Mutant "noSplice") is a no-op.
\* `self` is the releasing proc and its pc becomes selfPc.
ReleaseBody(self, selfPc) ==
  IF waiters # <<>>
    THEN LET g == Head(waiters)
             q == g[1]
             live == pc[q] = "waiting" /\ rounds[q] = g[2]
         IN /\ waiters' = Tail(waiters)
            /\ held' = held
            /\ timer' = IF live THEN [timer EXCEPT ![q] = FALSE] ELSE timer
            /\ pc' = IF live THEN [pc EXCEPT ![q] = "holding", ![self] = selfPc]
                             ELSE [pc EXCEPT ![self] = selfPc]
    ELSE /\ held' = FALSE
         /\ UNCHANGED <<waiters, timer>>
         /\ pc' = [pc EXCEPT ![self] = selfPc]

\* withWorkflowFileLock / tryWithWorkflowFileLock call the releaser in `finally`
\* (WorkflowRunStore.ts), so this also covers a throw inside the critical section.
Release(p) ==
  /\ pc[p] = "holding"
  /\ ReleaseBody(p, "idle")
  /\ stale' = [stale EXCEPT ![p] = TRUE]
  /\ UNCHANGED <<rounds, ticket, nextTicket>>

\* Calling a used releaser again: keyedFifoLock.ts:61-63 returns at once.
\* Under Mutant "noReleasedFlag" the body runs again; :66 asserts when the key is free.
StaleRelease(p) ==
  /\ stale[p]
  /\ pc[p] \in {"idle", "holding"}
  /\ stale' = [stale EXCEPT ![p] = FALSE]
  /\ IF Mutant = "noReleasedFlag" /\ held
       THEN ReleaseBody(p, pc[p])
       ELSE UNCHANGED <<held, waiters, pc, timer>>
  /\ UNCHANGED <<rounds, ticket, nextTicket>>

Terminated == \A p \in Procs : pc[p] = "idle" /\ rounds[p] = Rounds

Next ==
  \/ \E p \in Procs :
       TryAcquire(p) \/ CallAcquire(p) \/ Timeout(p) \/ Release(p) \/ StaleRelease(p)
  \/ (Terminated /\ UNCHANGED vars)

\* Holders eventually release. Timers get no fairness: a waiter may never time out.
Spec == Init /\ [][Next]_vars /\ \A p \in Procs : WF_vars(Release(p))

-----------------------------------------------------------------------------
TypeOK ==
  /\ held \in BOOLEAN
  /\ pc \in [Procs -> {"idle", "waiting", "holding"}]
  /\ timer \in [Procs -> BOOLEAN]

MutualExclusion == Cardinality(Holders) <= 1

\* The map entry exists exactly while the key is held; an idle key leaves no entry.
HeldIffOwner == held <=> Holders # {}

\* No retained waiter: the queue holds exactly the current grant of each waiting proc,
\* once, and only waiting procs keep an armed timer.
NoLeak ==
  /\ WaiterSet = {<<p, rounds[p]>> : p \in Waiting}
  /\ Len(waiters) = Cardinality(WaiterSet)
  /\ \A p \in Procs : timer[p] <=> pc[p] = "waiting"

\* A waiter never waits while the key is free.
NoLostWakeup == waiters # <<>> => held

\* Grants sit in arrival order.
QueueInArrivalOrder ==
  \A i, j \in 1..Len(waiters) : i < j => ticket[waiters[i][1]] < ticket[waiters[j][1]]

\* FIFO handoff: a waiter that gets the key arrived before every other waiter, and a new
\* caller never takes the key past a waiter.
FIFOHandoff ==
  [][\A p \in Procs :
       /\ (pc[p] = "waiting" /\ pc'[p] = "holding") =>
            \A q \in Waiting \ {p} : ticket[p] < ticket[q]
       /\ (pc[p] = "idle" /\ pc'[p] = "holding") => Waiting = {}]_vars

\* Every waiter eventually gets the key or gives up at its deadline.
WaiterResolves == \A p \in Procs : (pc[p] = "waiting") ~> (pc[p] # "waiting")
=============================================================================
