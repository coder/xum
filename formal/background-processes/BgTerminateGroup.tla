--------------------------- MODULE BgTerminateGroup ---------------------------
(***************************************************************************)
(* Design model for the rest of finding B1: who may signal a background   *)
(* process group, and on what evidence. Refines BgTerminate: the group is *)
(* a set of members, so the wrapper (leader) can exit while a member it   *)
(* started lingers (`sleep 30 & exit 3`, the B1 fixture).                 *)
(*                                                                        *)
(* POSIX fact the model rests on: a process group ID is not reused while  *)
(* the group has a member (XBD "Process ID Reuse"; on Linux a pid number  *)
(* stays allocated while any task has it as PGID). So `kill -<pgid>` can  *)
(* reach a stranger only after the group emptied (Reuse needs members={}).*)
(*                                                                        *)
(* Mode = "narrowed":   the narrowed #5471: one kill sequence, no         *)
(*   overwrite of an existing exit_code, signals sent from outside the    *)
(*   group (`kill -15 -N; sleep 2; kill -0 -N && kill -9 -N`). The early  *)
(*   return on a polled in-memory status stays.                           *)
(* Mode = "extcheck":   a supervisor S leads the group; terminate probes  *)
(*   S's identity (e.g. /proc start time) before EACH outside signal.     *)
(*   The probe is perfect; the check-to-signal window is not.             *)
(* Mode = "supervisor" (what ships, MC_group_supervisor): S leads the    *)
(*   group (bash, TERM caught) and is the parent of the wrapper;          *)
(*   terminate only files a stop request; S, a group member, signals its  *)
(*   own group (`kill -TERM 0`, `kill -KILL 0`) and records the wrapper's *)
(*   status from `wait`. Readers count the process as ended only when no  *)
(*   member is left; a stop that cannot see the group end (S killed, or a *)
(*   timeout) reports "unconfirmed" and may be retried, never signalling. *)
(*   NoSignalToReusedPgid is a safety property and holds even when a user *)
(*   process kills S; ending the group (StopKillsGroup on "done") needs a *)
(*   surviving S, so a killed S leaves the stop unconfirmed (liveness gap).*)
(* Environment switches: Linger (the wrapper leaves a member), ExecNoTrap *)
(* (`exec` drops the EXIT trap: no exit_code), Forge (the script writes   *)
(* exit_code itself while running), KillPin (a user process kills S).     *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS Mode, Linger, ExecNoTrap, Forge, KillPin,
          SupWaitsLinger,  \* S keeps serving while a lingering member lives (mutation: FALSE)
          TrustMarker      \* supervisor readers trust S's record alone, without the group (mutation: TRUE)

VARIABLES
  members,   \* subset of {"L" wrapper, "M" lingering member, "S" supervisor}
  reused,    \* the PGID now belongs to an unrelated group (only after members = {})
  marker,    \* exit_code file: "none" | "real" (trap) | "forged" | "143" | "137"
  lstat,     \* S's status file from `wait`: "none" | "real" | "stopped"
  lexit,     \* how the wrapper ended: "none" | "natural" | "signal"
  mem,       \* in-memory status: "running" | "exited" | "killed"
  req,       \* supervisor mode: stop request filed
  sstop,     \* S's stop sequence: "none" | "termed" | "done"
  pc,        \* terminate(): "idle" | "check" | "kill15" | "check2" | "kill9" | "wait" | "done" | "unconfirmed"
  hitOther,  \* history: a signal reached a reused PGID
  pinKilled  \* history: a user process killed S

vars == <<members, reused, marker, lstat, lexit, mem, req, sstop, pc, hitOther, pinKilled>>
HasSup == Mode \in {"extcheck", "supervisor"}

Init ==
  /\ members = IF HasSup THEN {"L", "S"} ELSE {"L"}
  /\ reused = FALSE /\ marker = "none" /\ lstat = "none" /\ lexit = "none"
  /\ mem = "running" /\ req = FALSE /\ sstop = "none" /\ pc = "idle"
  /\ hitOther = FALSE /\ pinKilled = FALSE

\* One signal to -PGID. TERM ends the wrapper (its trap writes 143) and the lingering
\* member; S ignores TERM. KILL ends everyone. A signal to an empty, reused group hits
\* a stranger; the model computes this from members, it does not assume who sent it.
Sig(sig) ==
  /\ hitOther' = (hitOther \/ (members = {} /\ reused))
  /\ members' = IF sig = "TERM" THEN members \cap {"S"} ELSE {}
  /\ lexit' = IF "L" \in members THEN "signal" ELSE lexit
  /\ marker' = IF "L" \in members /\ sig = "TERM" THEN "143" ELSE marker

StatusOf == IF lexit = "natural" THEN "real" ELSE "stopped"

\* --- Environment ---
LeaderExit ==
  /\ "L" \in members
  /\ \E lg \in (IF Linger THEN {TRUE, FALSE} ELSE {FALSE}),
        tr \in (IF ExecNoTrap THEN {TRUE, FALSE} ELSE {TRUE}) :
       /\ members' = (members \ {"L"}) \cup (IF lg THEN {"M"} ELSE {})
       /\ marker' = IF tr THEN "real" ELSE marker
  /\ lexit' = "natural"
  /\ UNCHANGED <<reused, lstat, mem, req, sstop, pc, hitOther, pinKilled>>
LingerExit ==
  /\ "M" \in members /\ members' = members \ {"M"}
  /\ UNCHANGED <<reused, marker, lstat, lexit, mem, req, sstop, pc, hitOther, pinKilled>>
ForgeMarker ==
  /\ Forge /\ "L" \in members /\ marker = "none" /\ marker' = "forged"
  /\ UNCHANGED <<members, reused, lstat, lexit, mem, req, sstop, pc, hitOther, pinKilled>>
KillSup ==   \* e.g. the script runs `kill -9 0` or `kill $PPID`
  /\ KillPin /\ "S" \in members /\ members \cap {"L", "M"} # {}
  /\ members' = members \ {"S"} /\ pinKilled' = TRUE
  /\ UNCHANGED <<reused, marker, lstat, lexit, mem, req, sstop, pc, hitOther>>
Reuse ==
  /\ members = {} /\ ~reused /\ reused' = TRUE
  /\ UNCHANGED <<members, marker, lstat, lexit, mem, req, sstop, pc, hitOther, pinKilled>>
Refresh ==   \* a poll reads the status file; never identity proof, but it gates terminate
  /\ mem = "running"
  /\ IF Mode = "supervisor"
       THEN lstat = "real" /\ (TrustMarker \/ members = {})
       ELSE marker \in {"real", "forged"}
  /\ mem' = "exited"
  /\ UNCHANGED <<members, reused, marker, lstat, lexit, req, sstop, pc, hitOther, pinKilled>>

\* --- Supervisor S (extcheck and supervisor modes) ---
SupReap ==   \* `wait $w` returned: S writes the wrapper's real status
  /\ HasSup /\ "S" \in members /\ "L" \notin members /\ lstat = "none"
  /\ lstat' = StatusOf
  /\ UNCHANGED <<members, reused, marker, lexit, mem, req, sstop, pc, hitOther, pinKilled>>
SupExit ==   \* S leaves once it is alone (or, mutated, as soon as the wrapper is done)
  /\ HasSup /\ "S" \in members /\ "L" \notin members /\ lstat # "none"
  /\ IF SupWaitsLinger THEN members = {"S"} ELSE TRUE
  /\ ~(Mode = "supervisor" /\ req /\ sstop = "none")
  /\ sstop # "termed"
  /\ members' = members \ {"S"}
  /\ UNCHANGED <<reused, marker, lstat, lexit, mem, req, sstop, pc, hitOther, pinKilled>>
SupTerm ==   \* `kill -TERM 0` from inside the group
  /\ Mode = "supervisor" /\ req /\ "S" \in members /\ sstop = "none"
  /\ Sig("TERM") /\ sstop' = "termed"
  /\ UNCHANGED <<reused, lstat, mem, req, pc, pinKilled>>
SupKill ==   \* status file first, then `kill -KILL 0` (S included)
  /\ Mode = "supervisor" /\ "S" \in members /\ sstop = "termed"
  /\ lstat' = IF lstat = "none" THEN (IF "L" \in members THEN "stopped" ELSE StatusOf) ELSE lstat
  /\ Sig("KILL") /\ sstop' = "done"
  /\ UNCHANGED <<reused, mem, req, pc, pinKilled>>

\* --- terminate(), one caller (the narrowed #5471 already gives one sequence) ---
Start ==     \* supervisor: a retry after "unconfirmed" starts over (the request is idempotent)
  /\ IF Mode = "supervisor" THEN pc \in {"idle", "unconfirmed"} ELSE pc = "idle"
  /\ IF Mode = "supervisor"
       THEN IF mem # "running" \/ members = {}
              THEN pc' = "done" /\ UNCHANGED req
                   /\ mem' = IF mem = "running" THEN "killed" ELSE mem
              ELSE pc' = "wait" /\ req' = TRUE /\ UNCHANGED mem
     ELSE IF mem = "running" THEN pc' = (IF Mode = "narrowed" THEN "kill15" ELSE "check")
                                  /\ UNCHANGED <<req, mem>>
     ELSE pc' = "done" /\ UNCHANGED <<req, mem>>
  /\ UNCHANGED <<members, reused, marker, lstat, lexit, sstop, hitOther, pinKilled>>
Check ==     \* extcheck: perfect identity probe of S, then (later) the signal
  /\ pc = "check" /\ pc' = IF "S" \in members THEN "kill15" ELSE "done"
  /\ UNCHANGED <<members, reused, marker, lstat, lexit, mem, req, sstop, hitOther, pinKilled>>
Kill15 ==
  /\ pc = "kill15" /\ Sig("TERM") /\ pc' = "check2"
  /\ UNCHANGED <<reused, lstat, mem, req, sstop, pinKilled>>
Check2 ==    \* after `sleep 2`: narrowed asks `kill -0 -N`; extcheck re-probes S
  /\ pc = "check2"
  /\ IF (IF Mode = "narrowed" THEN members # {} \/ reused ELSE "S" \in members)
       THEN pc' = "kill9" /\ UNCHANGED marker
       ELSE pc' = "done" /\ marker' = IF marker = "none" THEN "143" ELSE marker
  /\ mem' = "killed"
  /\ UNCHANGED <<members, reused, lstat, lexit, req, sstop, hitOther, pinKilled>>
Kill9 ==
  /\ pc = "kill9" /\ Sig("KILL") /\ pc' = "done"
  /\ marker' = IF marker = "none" /\ "L" \notin members THEN "137" ELSE marker
  /\ UNCHANGED <<reused, lstat, mem, req, sstop, pinKilled>>
Wait ==      \* supervisor: the group seen empty ends the wait; a group that outlives its
             \* supervisor makes the bounded wait report "unconfirmed" and leaves the
             \* in-memory status alone (a timeout with S alive is not modelled: S acts)
  /\ pc = "wait"
  /\ \/ members = {} /\ pc' = "done" /\ mem' = "killed"
     \/ members # {} /\ "S" \notin members /\ pc' = "unconfirmed" /\ UNCHANGED mem
  /\ UNCHANGED <<members, reused, marker, lstat, lexit, req, sstop, hitOther, pinKilled>>

Next == LeaderExit \/ LingerExit \/ ForgeMarker \/ KillSup \/ Reuse \/ Refresh
        \/ SupReap \/ SupExit \/ SupTerm \/ SupKill
        \/ Start \/ Check \/ Kill15 \/ Check2 \/ Kill9 \/ Wait
Spec == Init /\ [][Next]_vars

\* No signal ever reaches a PGID that is no longer this spawn's group.
NoSignalToReusedPgid == ~hitOther
\* The authoritative status of a wrapper that exited by itself says so.
NaturalExitPreserved ==
  lexit = "natural" =>
    IF Mode = "supervisor" THEN lstat \in {"none", "real"}
    ELSE marker \in {"none", "real", "forged"}
\* A finished stop leaves no wrapper and no lingering member (#5481). A stop ends
\* "unconfirmed" only when the user's own script killed the supervisor.
StopKillsGroup ==
  /\ pc = "done" => members \cap {"L", "M"} = {}
  /\ pc = "unconfirmed" => pinKilled
\* Xum never shows a process as ended (exited or killed) while a member still runs:
\* cleanup and checkout deletion trust that status.
NoFalseCompletion == mem # "running" => members \cap {"L", "M"} = {}

TypeOK ==
  /\ members \subseteq {"L", "M", "S"} /\ reused \in BOOLEAN
  /\ marker \in {"none", "real", "forged", "143", "137"}
  /\ lstat \in {"none", "real", "stopped"} /\ lexit \in {"none", "natural", "signal"}
  /\ mem \in {"running", "exited", "killed"}
=============================================================================
