------------------------- MODULE PlanLegacyFallback -------------------------
(***************************************************************************)
(* The read-only legacy fallback of installation-scoped SSH plans (#5174). *)
(*                                                                         *)
(* SSH plans live at ~/.mux/plans/installation-<uuid>/<project id>/<name>  *)
(* (getInstallationScopedPlanFilePath, the "scoped" file below). Rows from *)
(* older builds may still have their plan at the shared pre-#5174 path     *)
(* ~/.mux/plans/<basename>/<name>.md ("legacy"), which other installations *)
(* (or older builds of this one) also use, so Xum only ever reads it.      *)
(*                                                                         *)
(* Per-row flag remotePlanLegacyFallbackRetired ("retired"): monotone.     *)
(* While it is unset a read that finds no scoped plan copies the legacy    *)
(* one into the scoped path, then retires the flag (adoptSharedLegacyPlan, *)
(* src/node/utils/runtime/helpers.ts). A full clear retires the flag, then *)
(* deletes the scoped plan (WorkspaceService.deletePlanFilesOfMetadata).   *)
(*                                                                         *)
(* Actors: "a" (this installation's backend: clear, then read), "b" (a    *)
(* concurrent reader that adopts: the plan dialog, a sibling backend, any  *)
(* turn), "f" (another installation or an older build: writes the legacy  *)
(* file). A crash stops an actor between any two sub-steps and            *)
(* releases the legacy-plan lock it held (a dead holder's file lock is     *)
(* reclaimed).                                                             *)
(*                                                                         *)
(* Sub-steps (one per await point):                                        *)
(*  read   probe: scoped plan? -> read it. Retired? -> no plan. Else lock. *)
(*         lock: take the legacy-plan lock (LockedAdopt only).             *)
(*         copy: under the lock re-check the flag (LockedAdopt only), then *)
(*               copy legacy -> scoped unless scoped exists (hard link).   *)
(*         retire: persist the flag, release the lock.                     *)
(*  clear  retire: persist the flag, under the lock (released at once).    *)
(*         del: rm the scoped plan; the clear is complete.                 *)
(***************************************************************************)
EXTENDS Naturals, Sequences

CONSTANTS
  Crashes,  \* model crashes between sub-steps
  Fixes,    \* {"lockedAdopt"} = the code; {} = adoption without the lock and re-check
  Mutant    \* "none" or a mutation that must be caught

None == "none"
Actors == {"a", "b", "f"}

LockedAdopt == "lockedAdopt" \in Fixes
MutClearNoRetire == Mutant = "clearNoRetire"
MutRetireAfterDelete == Mutant = "retireAfterDelete"
MutAdoptMove == Mutant = "adoptMove"
MutRetireBeforeCopy == Mutant = "retireBeforeCopy"

Script == [x \in Actors |->
             CASE x = "a" -> <<"clear", "read">>
               [] x = "b" -> <<"read">>
               [] x = "f" -> <<"fwrite">>]

Steps == [read |-> IF MutRetireBeforeCopy THEN <<"probe", "lock", "retire", "copy">>
                                          ELSE <<"probe", "lock", "copy", "retire">>,
          clear |-> IF MutRetireAfterDelete THEN <<"del", "retire">> ELSE <<"retire", "del">>,
          fwrite |-> <<"do">>]

\* Plan contents by origin: "L" the pre-upgrade plan at the legacy path, "F" a foreign write there.
VARIABLES
  pc, sub, halted,
  legacy,         \* content of the shared legacy file
  scoped,         \* content of this workspace's scoped file (None = absent)
  retired,        \* the row's flag
  lock,           \* holder of the workspace's legacy-plan lock (None = free)
  clearStarted,   \* a clear began (its retirement may have landed)
  cleared,        \* a clear completed
  resurrected,    \* legacy content reached this workspace after a completed clear
  legacyTouched   \* Xum moved, deleted or wrote the legacy file

vars == <<pc, sub, halted, legacy, scoped, retired, lock, clearStarted, cleared, resurrected,
          legacyTouched>>

Contents == {None, "L", "F"}

TypeOK ==
  /\ pc \in [Actors -> 1..4]
  /\ sub \in [Actors -> 1..4]
  /\ halted \in [Actors -> BOOLEAN]
  /\ legacy \in Contents
  /\ scoped \in Contents
  /\ retired \in BOOLEAN
  /\ lock \in {None} \cup Actors
  /\ clearStarted \in BOOLEAN
  /\ cleared \in BOOLEAN
  /\ resurrected \in BOOLEAN
  /\ legacyTouched \in BOOLEAN

Init ==
  /\ pc = [x \in Actors |-> 1]
  /\ sub = [x \in Actors |-> 1]
  /\ halted = [x \in Actors |-> FALSE]
  /\ legacy = "L"
  /\ scoped = None
  /\ retired = FALSE
  /\ lock = None
  /\ clearStarted = FALSE
  /\ cleared = FALSE
  /\ resurrected = FALSE
  /\ legacyTouched = FALSE

Active(x) == ~halted[x] /\ pc[x] <= Len(Script[x])
Op(x) == Script[x][pc[x]]
Step(x) == Steps[Op(x)][sub[x]]

\* Finish the current sub-step; `done` ends the op early.
Advance(x, done) ==
  IF done \/ sub[x] = Len(Steps[Op(x)])
  THEN /\ pc' = [pc EXCEPT ![x] = pc[x] + 1]
       /\ sub' = [sub EXCEPT ![x] = 1]
  ELSE /\ sub' = [sub EXCEPT ![x] = sub[x] + 1]
       /\ UNCHANGED pc

\* A read hands `v` to the workspace (the agent, the plan dialog, a snapshot).
Deliver(v) == resurrected' = (resurrected \/ (cleared /\ v \in {"L", "F"}))

Release(x) == lock' = IF lock = x THEN None ELSE lock

Exec(x) ==
  /\ Active(x)
  /\ LET op == Op(x)
         st == Step(x) IN
     CASE op = "fwrite" ->
            /\ legacy' = "F"
            /\ Advance(x, FALSE)
            /\ UNCHANGED <<scoped, retired, lock, clearStarted, cleared, resurrected,
                           legacyTouched>>
       [] op = "read" /\ st = "probe" ->
            \/ /\ scoped # None
               /\ Deliver(scoped)
               /\ Advance(x, TRUE)
               /\ UNCHANGED <<legacy, scoped, retired, lock, clearStarted, cleared, legacyTouched>>
            \/ /\ scoped = None
               /\ Advance(x, retired)  \* retired: no plan; otherwise go on to the lock
               /\ UNCHANGED <<legacy, scoped, retired, lock, clearStarted, cleared, resurrected,
                              legacyTouched>>
       [] op = "read" /\ st = "lock" ->
            /\ IF LockedAdopt THEN /\ lock = None
                                   /\ lock' = x
                              ELSE UNCHANGED lock
            /\ Advance(x, FALSE)
            /\ UNCHANGED <<legacy, scoped, retired, clearStarted, cleared, resurrected,
                           legacyTouched>>
       [] op = "read" /\ st = "copy" ->
            IF LockedAdopt /\ retired /\ ~MutRetireBeforeCopy
            THEN \* A clear retired the fallback since the probe: no plan.
                 /\ Release(x)
                 /\ Advance(x, TRUE)
                 /\ UNCHANGED <<legacy, scoped, retired, clearStarted, cleared, resurrected,
                                legacyTouched>>
            ELSE \* The hard link never replaces an existing scoped plan.
                 /\ scoped' = IF scoped = None THEN legacy ELSE scoped
                 /\ Deliver(IF scoped = None THEN legacy ELSE scoped)
                 /\ IF MutAdoptMove THEN /\ legacy' = None
                                         /\ legacyTouched' = TRUE
                                    ELSE UNCHANGED <<legacy, legacyTouched>>
                 /\ IF MutRetireBeforeCopy THEN Release(x) ELSE UNCHANGED lock
                 /\ Advance(x, FALSE)
                 /\ UNCHANGED <<retired, clearStarted, cleared>>
       [] op = "read" /\ st = "retire" ->
            /\ retired' = TRUE
            /\ IF MutRetireBeforeCopy THEN UNCHANGED lock ELSE Release(x)
            /\ Advance(x, FALSE)
            /\ UNCHANGED <<legacy, scoped, clearStarted, cleared, resurrected, legacyTouched>>
       [] op = "clear" /\ st = "retire" ->
            \* Under the lock (taken and released within this step).
            /\ lock = None
            /\ retired' = (retired \/ ~MutClearNoRetire)
            /\ clearStarted' = TRUE
            /\ cleared' = (cleared \/ MutRetireAfterDelete)
            /\ Advance(x, FALSE)
            /\ UNCHANGED <<legacy, scoped, lock, resurrected, legacyTouched>>
       [] op = "clear" /\ st = "del" ->
            \* Only the scoped plan: the legacy file may be another installation's.
            /\ scoped' = None
            /\ clearStarted' = TRUE
            /\ cleared' = (cleared \/ ~MutRetireAfterDelete)
            /\ Advance(x, FALSE)
            /\ UNCHANGED <<legacy, retired, lock, resurrected, legacyTouched>>

Crash(x) ==
  /\ Crashes
  /\ Active(x)
  /\ halted' = [halted EXCEPT ![x] = TRUE]
  /\ Release(x)
  /\ UNCHANGED <<pc, sub, legacy, scoped, retired, clearStarted, cleared, resurrected,
                 legacyTouched>>

Next ==
  \/ \E x \in Actors : Exec(x) /\ UNCHANGED halted
  \/ \E x \in Actors : Crash(x)

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* Invariants. *)

\* After a completed full clear no read hands this workspace legacy content again (until it
\* writes a new plan, which this model's scripts do not), and no legacy copy is left at its path.
NoResurrection == ~resurrected /\ ~(cleared /\ scoped \in {"L", "F"})

\* Xum never moves, deletes or writes the shared legacy file.
NoLegacyTouch == ~legacyTouched

\* The fallback retires only once its plan is safe: copied into the scoped path, or cleared on
\* purpose. Otherwise a crash between the retirement and the copy would lose an older row's plan.
NoLostLegacyPlan == retired => (scoped # None \/ clearStarted)
=============================================================================
