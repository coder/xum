----------------------------- MODULE BgSpawnName -----------------------------
(***************************************************************************)
(* Two backends on one Xum root spawn a background process with the same  *)
(* display name in one workspace, at f30a1945a6:                           *)
(*   backgroundProcessManager.ts spawn (:1617-1800)                        *)
(*     host-local runtimes (local, worktree): `.spawn-name.lock` file lock *)
(*       held from the name probe until spawn() returns (:1670-1705);      *)
(*       recordDirIsFree (:127-182) is existence-only and frees a settled  *)
(*       record only when it is older than 24 h (not modelled: no time)    *)
(*     other runtimes (SSH/Coder, Docker, devcontainer, multi-project): no *)
(*       cross-process lock; runtimeSpawnDirMayHoldLiveProcess (:2799-2828)*)
(*       calls a dir free when it is absent OR holds exit_code             *)
(*   backgroundProcessExecutor.ts spawnProcess (:160-323): ensureDir,      *)
(*     truncate output.log, `rm -f exit_code` (:211-218), spawn (:261)     *)
(* A backend tracks its record until it crashes (Crash): the in-memory map *)
(* is lost, the record stays on disk.                                      *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
  Backends,      \* e.g. {"A", "B"}
  HostLocal,     \* TRUE: local/worktree path; FALSE: the remote path
  NoLock,        \* mutant: the host-local path skips the name lock
  CanCrash,
  Serial         \* spawns do not overlap: each starts after the others finished

VARIABLES
  dir,       \* record dir of the name: "absent" | "fresh" | "live" | "exited"
  owner,     \* backend whose spawn last initialised the dir, or "none"
  tracks,    \* [b]: b's in-memory map tracks a process in this dir
  lock,      \* holder of .spawn-name.lock, or "none"
  pc,        \* [b]: "idle" | "lock" | "probe" | "prep" | "spawn" | "unlock" | "done" | "suffix"
  alive,     \* [b]: b's child process runs
  clobbered  \* history: a dir another backend's process (live or tracked) uses was reinitialised

vars == <<dir, owner, tracks, lock, pc, alive, clobbered>>

Locking == HostLocal /\ ~NoLock

Init ==
  /\ dir = "absent" /\ owner = "none" /\ tracks = [b \in Backends |-> FALSE]
  /\ lock = "none" /\ pc = [b \in Backends |-> "idle"] /\ alive = [b \in Backends |-> FALSE]
  /\ clobbered = FALSE

Go(b, to) == pc' = [pc EXCEPT ![b] = to]

Start(b) == /\ pc[b] = "idle" /\ Go(b, IF Locking THEN "lock" ELSE "probe")
            /\ Serial => \A o \in Backends \ {b} : pc[o] \in {"idle", "done", "suffix"}
            /\ UNCHANGED <<dir, owner, tracks, lock, alive, clobbered>>
Lock(b) ==  /\ pc[b] = "lock" /\ lock = "none" /\ lock' = b /\ Go(b, "probe")   \* :1670
            /\ UNCHANGED <<dir, owner, tracks, alive, clobbered>>
Probe(b) == \* host: lstat, free only when absent (:127-136); remote: absent or exit_code (:2808)
  /\ pc[b] = "probe"
  /\ IF dir = "absent" \/ (~HostLocal /\ dir = "exited")
       THEN Go(b, "prep") ELSE Go(b, "suffix")                         \* suffix: another name
  /\ UNCHANGED <<dir, owner, tracks, lock, alive, clobbered>>
Prep(b) ==  \* executor :211-218 ensureDir, truncate output.log, rm -f exit_code
  /\ pc[b] = "prep"
  /\ clobbered' = (clobbered \/ (owner \notin {"none", b} /\ (alive[owner] \/ tracks[owner])))
  /\ dir' = "fresh" /\ owner' = b /\ Go(b, "spawn")
  /\ UNCHANGED <<tracks, lock, alive>>
Spawn(b) == \* :1727 child live; :1761 writeMeta; :1800 tracked
  /\ pc[b] = "spawn"
  /\ alive' = [alive EXCEPT ![b] = TRUE] /\ tracks' = [tracks EXCEPT ![b] = TRUE]
  /\ dir' = IF owner = b THEN "live" ELSE dir
  /\ Go(b, IF Locking THEN "unlock" ELSE "done")
  /\ UNCHANGED <<owner, lock, clobbered>>
Unlock(b) == /\ pc[b] = "unlock" /\ lock' = "none" /\ Go(b, "done")
             /\ UNCHANGED <<dir, owner, tracks, alive, clobbered>>

Exit(b) ==  \* the wrapper's trap writes exit_code into the dir its process was spawned in
  /\ alive[b] /\ alive' = [alive EXCEPT ![b] = FALSE]
  /\ dir' = IF owner = b THEN "exited" ELSE dir
  /\ UNCHANGED <<owner, tracks, lock, pc, clobbered>>
Crash(b) == \* the backend dies: map lost, record and process survive; lock reclaimed (dead pid)
  /\ CanCrash /\ tracks[b]
  /\ tracks' = [tracks EXCEPT ![b] = FALSE]
  /\ lock' = IF lock = b THEN "none" ELSE lock
  /\ pc' = [pc EXCEPT ![b] = "done"]
  /\ UNCHANGED <<dir, owner, alive, clobbered>>

Next == \E b \in Backends :
          Start(b) \/ Lock(b) \/ Probe(b) \/ Prep(b) \/ Spawn(b) \/ Unlock(b) \/ Exit(b) \/ Crash(b)
Spec == Init /\ [][Next]_vars

\* A record name is never reused while its process may run or its backend still tracks it
\* (the tracker would read the new command's output.log and exit_code as its own).
NoReuseWhileTracked == ~clobbered
\* Two live processes never share one record dir (only spawns that took the probed name
\* are modelled; a suffixed name is another dir).
OneProcessPerDir == \A b1, b2 \in Backends : b1 # b2 => ~(alive[b1] /\ alive[b2])

TypeOK == dir \in {"absent", "fresh", "live", "exited"} /\ lock \in Backends \cup {"none"}
=============================================================================
