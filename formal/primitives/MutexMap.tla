------------------------------ MODULE MutexMap ------------------------------
(***************************************************************************)
(* Model of src/node/utils/concurrency/mutexMap.ts (and workspaceFileLocks,*)
(* which is one shared MutexMap instance) for one key. Keys are            *)
(* independent Map entries, so one key is enough.                          *)
(*                                                                         *)
(* Each withLock() call owns a promise token <<proc, round, depth>>. The   *)
(* segment before the first await (mutexMap.ts:27-37) chains onto the     *)
(* previous token and publishes its own. `await previousLock` (:40) resumes *)
(* after that token resolves (Promise.resolve() when there was none). The  *)
(* `finally` (:42-47) is one segment; it runs on success and on a throw    *)
(* from operation(), so exceptions need no separate action.                *)
(*                                                                         *)
(* AllowNested lets a running operation call withLock() on the same key    *)
(* again (depth 1), to check reentrancy.                                   *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
  Procs,
  Rounds,
  AllowNested,
  Mutant   \* "none" | "deleteAlways" (finally deletes the entry unconditionally)

VARIABLES
  last,      \* mutexMap.ts:18 `locks.get(key)`; NoToken when absent
  resolved,  \* tokens whose lockPromise resolved (:43 releaseLock())
  prev,      \* prev[p][d]: token the depth-d call awaits (:27)
  pc,        \* "idle" | "waiting" | "running" | "nwaiting" | "nrunning"
  rounds,
  ticket,
  nextTicket

vars == <<last, resolved, prev, pc, rounds, ticket, nextTicket>>

NoToken == <<>>
Tok(p, d) == <<p, rounds[p], d>>

Running == {p \in Procs : pc[p] \in {"running", "nwaiting", "nrunning"}}
Waiting == {p \in Procs : pc[p] = "waiting"}

Init ==
  /\ last = NoToken
  /\ resolved = {}
  /\ prev = [p \in Procs |-> [d \in 0..1 |-> NoToken]]
  /\ pc = [p \in Procs |-> "idle"]
  /\ rounds = [p \in Procs |-> 0]
  /\ ticket = [p \in Procs |-> 0]
  /\ nextTicket = 1

Done(t) == t = NoToken \/ t \in resolved

\* mutexMap.ts:25-37: chain onto the current token and publish ours, before any await.
Enter(p) ==
  /\ pc[p] = "idle"
  /\ rounds[p] < Rounds
  /\ rounds' = [rounds EXCEPT ![p] = @ + 1]
  /\ ticket' = [ticket EXCEPT ![p] = nextTicket]
  /\ nextTicket' = nextTicket + 1
  /\ prev' = [prev EXCEPT ![p][0] = last]
  /\ last' = <<p, rounds[p] + 1, 0>>
  /\ pc' = [pc EXCEPT ![p] = "waiting"]
  /\ UNCHANGED resolved

\* mutexMap.ts:40-41: `await previousLock` resumed; operation() starts.
Resume(p) ==
  /\ pc[p] = "waiting"
  /\ Done(prev[p][0])
  /\ pc' = [pc EXCEPT ![p] = "running"]
  /\ UNCHANGED <<last, resolved, prev, rounds, ticket, nextTicket>>

\* The same key, entered again from inside a running operation.
NestedEnter(p) ==
  /\ AllowNested
  /\ pc[p] = "running"
  /\ prev' = [prev EXCEPT ![p][1] = last]
  /\ last' = Tok(p, 1)
  /\ pc' = [pc EXCEPT ![p] = "nwaiting"]
  /\ UNCHANGED <<resolved, rounds, ticket, nextTicket>>

NestedResume(p) ==
  /\ pc[p] = "nwaiting"
  /\ Done(prev[p][1])
  /\ pc' = [pc EXCEPT ![p] = "nrunning"]
  /\ UNCHANGED <<last, resolved, prev, rounds, ticket, nextTicket>>

\* mutexMap.ts:42-47 `finally`: resolve our token; delete the entry only if still ours.
FinallyEffect(p, d) ==
  /\ resolved' = resolved \cup {Tok(p, d)}
  /\ last' = IF last = Tok(p, d) \/ Mutant = "deleteAlways" THEN NoToken ELSE last

NestedFinish(p) ==
  /\ pc[p] = "nrunning"
  /\ FinallyEffect(p, 1)
  /\ pc' = [pc EXCEPT ![p] = "running"]
  /\ UNCHANGED <<prev, rounds, ticket, nextTicket>>

Finish(p) ==
  /\ pc[p] = "running"
  /\ FinallyEffect(p, 0)
  /\ pc' = [pc EXCEPT ![p] = "idle"]
  /\ UNCHANGED <<prev, rounds, ticket, nextTicket>>

Terminated == \A p \in Procs : pc[p] = "idle" /\ rounds[p] = Rounds

Next ==
  \/ \E p \in Procs :
       Enter(p) \/ Resume(p) \/ NestedEnter(p) \/ NestedResume(p) \/ NestedFinish(p)
       \/ Finish(p)
  \/ (Terminated /\ UNCHANGED vars)

Spec ==
  Init /\ [][Next]_vars
  /\ \A p \in Procs : WF_vars(Resume(p)) /\ WF_vars(Finish(p))

-----------------------------------------------------------------------------
\* At most one operation per key runs (between its resume and its finally).
MutualExclusion == Cardinality(Running) <= 1

\* The Map entry is gone once every call on the key finished (no idle-key leak), and
\* while present it names a call that has not finished yet.
EntryRemovedWhenIdle ==
  /\ (Running = {} /\ Waiting = {}) => last = NoToken
  /\ last # NoToken => last \notin resolved

\* Operations run in call order.
FIFO ==
  [][\A p \in Procs :
       (pc[p] = "waiting" /\ pc'[p] = "running") =>
         \A q \in Waiting \ {p} : ticket[p] < ticket[q]]_vars

WaiterProgress == \A p \in Procs : (pc[p] = "waiting") ~> (pc[p] = "running")
=============================================================================
