----------------------------- MODULE InitReplay -----------------------------
(***************************************************************************)
(* #4918: the init record of one workspace, written by the backend that   *)
(* runs its init hook (owner O) and judged by another backend's replay    *)
(* (R) on the same Xum root, at commit ea52e87b33:                         *)
(*   src/node/services/initStateManager.ts   startInit (:189-205, persist *)
(*       not awaited), endInit (:325-360), replayInit (:416-438) +         *)
(*       readUnownedRunningInit (:447-452)                                 *)
(*   src/node/runtime/runtimeFactory.ts      runBackgroundInit (:67-84),   *)
(*       withInitUseLease (:92-106)                                        *)
(*   src/node/services/workspaceService.ts   logComplete ->                *)
(*       `void initStateManager.endInit(...)` (:4900)                      *)
(* Each persist is one atomic file write; O's writes land in issue order  *)
(* but asynchronously (not awaited), R's write lands in its own step.      *)
(* The fix: InitStateManager holds a per-backend "init record" lock from  *)
(* before startInit's "running" write until endInit's final write landed  *)
(* (or the in-memory state is cleared), and replay probes it beside the   *)
(* init lease. `lease` under HoldBeforeStart /\ EndBeforeRelease models  *)
(* that lock (MC_init_fixed); R's re-read and write stay two steps.       *)
(***************************************************************************)
EXTENDS Naturals, Sequences

CONSTANTS
  Outcomes,       \* hook results O may report: subset of {"success", "error"}
  Replays,        \* how many replays R may run (reconnects / history replays)
  EndBeforeRelease, \* fix: O awaits its final write before releasing the lease
  HoldBeforeStart   \* fix: O takes the lease before its "running" write

VARIABLES
  rec,      \* persisted status: "none" | "running" | "success" | "error"
  oq,       \* O's issued, not yet landed writes (FIFO)
  opc, outcome,
  lease,    \* O holds its "init" use lease
  rpc, rseen, replays

vars == <<rec, oq, opc, outcome, lease, rpc, rseen, replays>>

Init ==
  /\ rec = "none" /\ oq = <<>> /\ opc = "start" /\ outcome = "none"
  /\ lease = FALSE /\ rpc = "idle" /\ rseen = "none" /\ replays = 0

\* --- Owner O ---
OStart ==        \* startInit: `void this.store.persist(running)` (:205)
  /\ opc = "start"
  /\ IF HoldBeforeStart
       THEN lease' = TRUE /\ oq' = Append(oq, "running")
       ELSE UNCHANGED lease /\ oq' = Append(oq, "running")
  /\ opc' = "hold" /\ UNCHANGED <<rec, outcome, rpc, rseen, replays>>
OHold ==         \* withInitUseLease: hold(ws, "init") (runtimeFactory.ts:97)
  /\ opc = "hold" /\ lease' = TRUE /\ opc' = "run"
  /\ UNCHANGED <<rec, oq, outcome, rpc, rseen, replays>>
ORunEnd ==       \* the hook runs; logComplete -> void endInit(exit) (:4900)
  /\ opc = "run"
  /\ \E o \in Outcomes : outcome' = o /\ oq' = Append(oq, o)
  /\ opc' = "release" /\ UNCHANGED <<rec, lease, rpc, rseen, replays>>
ORelease ==      \* finally: lease.release() (runtimeFactory.ts:102)
  /\ opc = "release"
  /\ EndBeforeRelease => oq = <<>>
  /\ lease' = FALSE /\ opc' = "done"
  /\ UNCHANGED <<rec, oq, outcome, rpc, rseen, replays>>
OLand ==         \* O's next pending write lands (EventStore persist)
  /\ oq # <<>> /\ rec' = Head(oq) /\ oq' = Tail(oq)
  /\ UNCHANGED <<opc, outcome, lease, rpc, rseen, replays>>

\* --- Replayer R (no in-memory state for the workspace, :417) ---
RRead ==         \* :448 read the record; continue only on "running"
  /\ rpc = "idle" /\ replays < Replays
  /\ replays' = replays + 1
  /\ rpc' = IF rec = "running" THEN "probe" ELSE "idle"
  /\ UNCHANGED <<rec, oq, opc, outcome, lease, rseen>>
RProbe ==        \* :449 isHeld(ws, "init")
  /\ rpc = "probe" /\ rpc' = IF lease THEN "idle" ELSE "reread"
  /\ UNCHANGED <<rec, oq, opc, outcome, lease, rseen, replays>>
RReread ==       \* :450-451 read again
  /\ rpc = "reread" /\ rpc' = IF rec = "running" THEN "write" ELSE "idle"
  /\ UNCHANGED <<rec, oq, opc, outcome, lease, rseen, replays>>
RWrite ==        \* :424-433 persist status "error" (no guard, no lock)
  /\ rpc = "write" /\ rec' = "error" /\ rpc' = "idle"
  /\ UNCHANGED <<oq, opc, outcome, lease, rseen, replays>>

Next == OStart \/ OHold \/ ORunEnd \/ ORelease \/ OLand
        \/ RRead \/ RProbe \/ RReread \/ RWrite

Spec == Init /\ [][Next]_vars

\* Once O finished and its writes landed and R is idle, the record says what
\* the hook reported: a successful init is never replayed as interrupted.
FinalRecordCorrect ==
  (opc = "done" /\ oq = <<>> /\ rpc = "idle") => rec = outcome
\* A record O is still running is never marked failed (#4918 gap 1 window).
NoErrorWhileOwnerRuns ==
  (opc \in {"hold", "run", "release"} /\ rec = "error") => outcome = "error"

TypeOK == rec \in {"none", "running", "success", "error"} /\ Len(oq) <= 2
=============================================================================
