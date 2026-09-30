---------------------------- MODULE AsyncMutex ----------------------------
(***************************************************************************)
(* Model of src/node/utils/concurrency/asyncMutex.ts.                      *)
(*                                                                         *)
(* Node runs the code between two awaits atomically, so every action below *)
(* is one await-free segment. Interleavings happen only where a segment    *)
(* ends: at `await` (asyncMutex.ts:25) or when a caller's own code runs.   *)
(*                                                                         *)
(* A waiter woken by release() does not run at once: `next()` only resolves *)
(* its promise (asyncMutex.ts:60), and the waiter's `while` re-check runs   *)
(* in a later microtask. Any segment already queued, or the rest of the     *)
(* releasing segment itself, may run first. The "woken" state models that  *)
(* gap.                                                                    *)
(*                                                                         *)
(* A throw inside the critical section is not a separate action: callers   *)
(* use `await using`, which disposes (Release) on the throw path too.      *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
  Procs,              \* contenders
  Rounds,             \* acquisitions per contender (bounds the state space)
  AllowTry,           \* contenders may also call tryAcquire() (asyncMutex.ts:45)
  AllowDoubleRelease, \* a contender may dispose an already-disposed handle once more
  Mutant              \* "none" = faithful; "ifNotWhile" = mutation sanity check

VARIABLES
  locked,     \* asyncMutex.ts:15 `locked`
  queue,      \* asyncMutex.ts:16 `queue` (each resolver identified by its proc)
  ready,      \* woken waiters whose continuation is queued, in microtask (FIFO) order
  pc,         \* "idle" | "parked" | "woken" | "holding"
  rounds,     \* acquisitions started per proc
  ticket,     \* arrival order of the proc's current acquire() call
  nextTicket,
  stale       \* proc still has a handle that was already disposed

vars == <<locked, queue, ready, pc, rounds, ticket, nextTicket, stale>>

Holders == {p \in Procs : pc[p] = "holding"}
Waiting == {p \in Procs : pc[p] \in {"parked", "woken"}}
QueueSet == {queue[i] : i \in 1..Len(queue)}

Init ==
  /\ locked = FALSE
  /\ queue = <<>>
  /\ ready = <<>>
  /\ pc = [p \in Procs |-> "idle"]
  /\ rounds = [p \in Procs |-> 0]
  /\ ticket = [p \in Procs |-> 0]
  /\ nextTicket = 1
  /\ stale = [p \in Procs |-> FALSE]

\* asyncMutex.ts:22-30. `acquire` is async, but its body runs synchronously up to the
\* first await, so the first `while (this.locked)` check happens in the caller's segment.
CallAcquire(p) ==
  /\ pc[p] = "idle"
  /\ rounds[p] < Rounds
  /\ rounds' = [rounds EXCEPT ![p] = @ + 1]
  /\ ticket' = [ticket EXCEPT ![p] = nextTicket]
  /\ nextTicket' = nextTicket + 1
  /\ IF ~locked
       THEN /\ locked' = TRUE                          \* :28
            /\ pc' = [pc EXCEPT ![p] = "holding"]
            /\ queue' = queue
       ELSE /\ queue' = Append(queue, p)               \* :25 push resolver, await
            /\ pc' = [pc EXCEPT ![p] = "parked"]
            /\ locked' = locked
  /\ UNCHANGED <<ready, stale>>

\* asyncMutex.ts:45-51 tryAcquire(): synchronous check-and-take, null when locked.
TryAcquire(p) ==
  /\ AllowTry
  /\ pc[p] = "idle"
  /\ rounds[p] < Rounds
  /\ rounds' = [rounds EXCEPT ![p] = @ + 1]
  /\ IF ~locked
       THEN /\ locked' = TRUE
            /\ pc' = [pc EXCEPT ![p] = "holding"]
       ELSE UNCHANGED <<locked, pc>>
  /\ UNCHANGED <<queue, ready, ticket, nextTicket, stale>>

\* asyncMutex.ts:24-25, the waiter's continuation after `await`: re-run the while check.
\* Mutant "ifNotWhile" replaces the `while` with an `if` (takes the lock unconditionally).
Resume(q) ==
  /\ ready # <<>>
  /\ q = Head(ready)       \* continuations run in the order their promises resolved
  /\ ready' = Tail(ready)
  /\ IF ~locked \/ Mutant = "ifNotWhile"
       THEN /\ locked' = TRUE
            /\ pc' = [pc EXCEPT ![q] = "holding"]
            /\ queue' = queue
       ELSE /\ queue' = Append(queue, q)               \* back to the TAIL of the queue
            /\ pc' = [pc EXCEPT ![q] = "parked"]
            /\ locked' = locked
  /\ UNCHANGED <<rounds, ticket, nextTicket, stale>>

\* asyncMutex.ts:57-63 release(): clear `locked`, resolve the first waiter (it runs later).
\* p's own pc becomes newPc. Head(queue) # p: a parked proc cannot run.
ReleaseEffect(p, newPc) ==
  /\ locked' = FALSE
  /\ IF queue # <<>>
       THEN /\ queue' = Tail(queue)
            /\ ready' = Append(ready, Head(queue))
            /\ pc' = [pc EXCEPT ![Head(queue)] = "woken", ![p] = newPc]
       ELSE /\ queue' = queue
            /\ ready' = ready
            /\ pc' = [pc EXCEPT ![p] = newPc]

\* asyncMutex.ts:78-81 AsyncMutexLock[Symbol.asyncDispose]() -> release(). Runs on the
\* normal and the throw path of `await using`.
Release(p) ==
  /\ pc[p] = "holding"
  /\ ReleaseEffect(p, "idle")
  /\ stale' = [stale EXCEPT ![p] = AllowDoubleRelease]
  /\ UNCHANGED <<rounds, ticket, nextTicket>>

\* Disposing the same AsyncMutexLock again (or calling the public mutex.release() as a
\* non-holder, which has the same effect): AsyncMutexLock has no `released` flag.
StaleRelease(p) ==
  /\ stale[p]
  /\ pc[p] \in {"idle", "holding"}
  /\ ReleaseEffect(p, pc[p])
  /\ stale' = [stale EXCEPT ![p] = FALSE]
  /\ UNCHANGED <<rounds, ticket, nextTicket>>

Terminated == \A p \in Procs : pc[p] = "idle" /\ rounds[p] = Rounds

Next ==
  \/ \E p \in Procs :
       CallAcquire(p) \/ TryAcquire(p) \/ Resume(p) \/ Release(p) \/ StaleRelease(p)
  \/ (Terminated /\ UNCHANGED vars)

\* Holders eventually release and woken waiters eventually get their microtask.
Fairness == \A p \in Procs : WF_vars(Release(p)) /\ WF_vars(Resume(p))

Spec == Init /\ [][Next]_vars /\ Fairness

-----------------------------------------------------------------------------
TypeOK ==
  /\ locked \in BOOLEAN
  /\ pc \in [Procs -> {"idle", "parked", "woken", "holding"}]
  /\ \A i \in 1..Len(queue) : queue[i] \in Procs

MutualExclusion == Cardinality(Holders) <= 1

\* `locked` is true exactly while someone holds the lock.
LockedIffHeld == locked <=> Holders # {}

\* No retained resolver: the queue holds exactly the parked procs, each once.
QueueIsParked ==
  /\ QueueSet = {p \in Procs : pc[p] = "parked"}
  /\ Len(queue) = Cardinality(QueueSet)

\* No lost wakeup: while the lock is free, a parked waiter implies a pending wakeup.
NoLostWakeup == (~locked /\ queue # <<>>) => ready # <<>>

\* The microtask queue holds exactly the woken procs, each once.
ReadyIsWoken ==
  /\ {ready[i] : i \in 1..Len(ready)} = {p \in Procs : pc[p] = "woken"}
  /\ Len(ready) = Cardinality({ready[i] : i \in 1..Len(ready)})

\* FIFO among queued waiters: a waiter that takes the lock arrived before every other
\* proc still waiting.
FIFOAmongWaiters ==
  [][\A p \in Procs :
       (pc[p] = "woken" /\ pc'[p] = "holding") =>
         \A q \in Waiting \ {p} : ticket[p] < ticket[q]]_vars

\* No barging: a new acquire()/tryAcquire() never takes the lock past a waiter.
NoBarging ==
  [][\A p \in Procs : (pc[p] = "idle" /\ pc'[p] = "holding") => Waiting = {}]_vars

\* Every waiter eventually holds the lock (starvation freedom within the bounds).
WaiterProgress == \A p \in Procs : (pc[p] = "parked") ~> (pc[p] = "holding")
=============================================================================
