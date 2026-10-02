----------------------------- MODULE BgTerminate -----------------------------
(***************************************************************************)
(* Terminating one background process, at commit f30a1945a6:              *)
(*   src/node/services/backgroundProcessManager.ts terminate (:2950-3050): *)
(*       returns early only when the IN-MEMORY status is no longer         *)
(*       "running" (:2964); the status becomes "killed" after the awaited  *)
(*       handle.terminate() (:2997-3000)                                   *)
(*   src/node/services/backgroundProcessExecutor.ts                        *)
(*       RuntimeBackgroundHandle.terminate (:506-523): `terminated` is set *)
(*       after the awaited kill command                                    *)
(*   src/node/runtime/backgroundCommands.ts buildTerminateCommand          *)
(*       (:135-155): `kill -15 -pgid; sleep 2; if kill -0 -pgid then       *)
(*       kill -9, write 137 else write 143` -- no exit_code check first    *)
(* The in-memory status follows a natural exit only when something polls  *)
(* it (getProcess, refreshRunningStatuses, the monitor tail): Refresh.     *)
(* Once the process exited, its PGID may be reused by an unrelated group  *)
(* (Reuse). Callers: task_stop/terminate, the timeout timer, cleanup.      *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
  Callers,        \* concurrent terminate() calls, e.g. {"stop", "timer"}
  CheckMarker,    \* fix: the kill command skips SIGTERM when exit_code exists
  CheckEscalation,\* fix probe: the escalation (kill -0/-9) also skips when exit_code exists
  OnceGuard       \* fix: a synchronous "terminating" latch before the first await

VARIABLES
  alive,       \* the process group still runs
  marker,      \* exit_code file: "none" | "real" (wrapper trap) | "143" | "137"
  pgOwner,     \* who owns the PGID now: "P" | "none" (free) | "other" (reused)
  mem,         \* in-memory status: "running" | "exited" | "killed"
  latch,       \* fix only: a terminate is in flight
  pc,          \* [c]: "idle" | "kill" | "check" | "done"
  hitOther,    \* history: a signal reached an unrelated reused group
  sequences,   \* kill sequences started
  natural      \* history: the process exited by itself (not by a signal)

vars == <<alive, marker, pgOwner, mem, latch, pc, hitOther, sequences, natural>>

Init ==
  /\ alive = TRUE /\ marker = "none" /\ pgOwner = "P" /\ mem = "running"
  /\ latch = FALSE /\ pc = [c \in Callers |-> "idle"] /\ hitOther = FALSE /\ sequences = 0
  /\ natural = FALSE

\* --- Environment ---
Exit ==      \* the wrapper's EXIT trap writes the real exit code, then the group is gone
  /\ alive /\ alive' = FALSE /\ marker' = "real" /\ pgOwner' = "none" /\ natural' = TRUE
  /\ UNCHANGED <<mem, latch, pc, hitOther, sequences>>
Reuse ==     \* an unrelated process group gets the freed PGID
  /\ pgOwner = "none" /\ pgOwner' = "other"
  /\ UNCHANGED <<alive, marker, mem, latch, pc, hitOther, sequences, natural>>
Refresh ==   \* getProcess / refreshRunningStatuses / monitor read exit_code (:2026-2037)
  /\ mem = "running" /\ marker = "real" /\ mem' = "exited"
  /\ UNCHANGED <<alive, marker, pgOwner, latch, pc, hitOther, sequences, natural>>

\* The kill command's own exit code: at f30a1945a6 it overwrites whatever the trap wrote; the
\* fix publishes with noclobber (`set -C`), so an existing code wins.
Publish(code) == IF CheckMarker /\ marker # "none" THEN marker ELSE code

\* --- terminate(), one per caller ---
Start(c) ==  \* :2964 status check, then await handle.terminate()
  /\ pc[c] = "idle"
  /\ IF mem = "running" /\ ~(OnceGuard /\ latch)
       THEN pc' = [pc EXCEPT ![c] = "kill"] /\ latch' = TRUE /\ sequences' = sequences + 1
       ELSE pc' = [pc EXCEPT ![c] = "done"] /\ UNCHANGED <<latch, sequences>>
  /\ UNCHANGED <<alive, marker, pgOwner, mem, hitOther, natural>>
Kill15(c) == \* `kill -15 -pgid` (fix: `[ -f exit_code ] ||` in the same shell command)
  /\ pc[c] = "kill"
  /\ IF CheckMarker /\ marker # "none"
       THEN pc' = [pc EXCEPT ![c] = "done"] /\ UNCHANGED <<alive, marker, pgOwner, hitOther>>
            /\ mem' = IF mem = "running" THEN "exited" ELSE mem
       ELSE /\ hitOther' = (hitOther \/ pgOwner = "other")
            /\ IF alive   \* SIGTERM ends the group; the trap writes its own code
                 THEN alive' = FALSE /\ marker' = "real" /\ pgOwner' = "none"
                 ELSE UNCHANGED <<alive, marker, pgOwner>>
            /\ pc' = [pc EXCEPT ![c] = "check"] /\ UNCHANGED mem
  /\ UNCHANGED <<latch, sequences, natural>>
\* The shipped fix (MC_term_shipped) sets CheckEscalation = FALSE: after its own SIGTERM the
\* wrapper's trap can record its code while a member that ignores SIGTERM keeps the group alive
\* (this model folds the group into one process and cannot show that member), so the code
\* escalates on `kill -0` alone and a PGID reused during `sleep 2` stays reachable.
Check(c) ==  \* `sleep 2; if kill -0 -pgid ...`: a reused group answers kill -0
  /\ pc[c] = "check"
  /\ IF CheckEscalation /\ marker = "real"   \* probe: the trap already recorded the exit
       THEN UNCHANGED <<hitOther, marker>>
       ELSE IF pgOwner = "other"          \* a PGID freed during `sleep 2` was reused
       THEN hitOther' = TRUE /\ marker' = Publish("137")  \* kill -9 the stranger
       ELSE UNCHANGED hitOther /\ marker' = Publish("143")
  /\ mem' = "killed" /\ pc' = [pc EXCEPT ![c] = "done"]
  /\ UNCHANGED <<alive, pgOwner, latch, sequences, natural>>

Next == Exit \/ Reuse \/ Refresh \/ \E c \in Callers : Start(c) \/ Kill15(c) \/ Check(c)
Spec == Init /\ [][Next]_vars

\* A signal never reaches a process group that is not this record's.
NoSignalToReusedPgid == ~hitOther
\* A process that exited by itself keeps the exit code its trap wrote: a later stop is
\* not reported as "killed with 143".
NaturalExitPreserved == natural => marker = "real"
\* At most one kill sequence per process.
OneKillSequence == sequences <= 1

TypeOK == alive \in BOOLEAN /\ marker \in {"none", "real", "143", "137"}
          /\ pgOwner \in {"P", "none", "other"} /\ mem \in {"running", "exited", "killed"}
=============================================================================
