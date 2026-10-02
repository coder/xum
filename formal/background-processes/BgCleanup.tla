------------------------------ MODULE BgCleanup ------------------------------
(***************************************************************************)
(* One backend, one workspace W: background spawns and foreground->        *)
(* background migrations racing removal or archive, at f30a1945a6:        *)
(*   backgroundProcessManager.ts  spawn (:1617-1800): no seal check, no    *)
(*       pending entry; registers in `processes` only at :1800, after the  *)
(*       awaited name lock (:1670), spawnProcess (:1727; the child is live *)
(*       from here) and writeMeta (:1761)                                  *)
(*     beginMigration (:1435-1481): `admitted` = not sealed, checked once; *)
(*       the migration counts as pending until its using-block exits       *)
(*     cleanup (:3074-3099): seal, drain pending migrations, snapshot      *)
(*       `processes`, terminate the snapshot, drain again, unseal          *)
(*   tools/bash.ts  migration block (:1424-1570): claim (await), exit      *)
(*       check, unregister foreground, migrateToBackground (await),        *)
(*       registerMigratedProcess; refused => kill and join                 *)
(*   workspaceService.ts removeUnlocked (:7240-8251): migration seal from  *)
(*       :7378 until it settles, stopStream, cleanup (:7603), checkout     *)
(*       deletion (:7710); archiveUnlocked (:11533-): stops the stream,    *)
(*       terminals and MCP servers (:4215-4237) but never calls cleanup or *)
(*       terminate; a snapshot/delete archive deletes the checkout         *)
(* Fix probes (the code after the B2/B3 fix): SpawnSealed = spawn() is   *)
(*   admitted under the migration seal (refused when sealed at entry and *)
(*   again once it holds its name) and pending until registered;         *)
(*   ArchiveCleans = archive seals and runs cleanup() before it stops the *)
(*   stream, runs its hooks or deletes the checkout.                      *)
(* Terminate is modelled as effective (it is best-effort in the code; see *)
(* BgTerminate.tla). The bash tool never checks its abort signal around   *)
(* spawn (bash.ts:1050-1085), so stopStream does not stop a spawn.        *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
  HasSpawn,      \* a run_in_background spawn is in flight when the mutation starts
  HasMigration,  \* a foreground command whose migration may be requested
  Mutator,       \* "remove" | "archive" (archive: snapshot/delete behaviour)
  SpawnSealed,   \* fix: spawn takes a pending entry refused by the seal, like migrations
  ArchiveCleans, \* fix: archive seals and runs cleanup before stopping the stream or deleting
  NoDrain        \* mutant: cleanup does not wait for pending migrations (#4805 undone)

VARIABLES
  \* spawn
  spc, sLive, sReg,
  \* migration
  mpc, fLive, fg, bg, mPending, mAdmitted,
  \* mutator
  rpc, seals, snapshot, deleted, stopped

vars == <<spc, sLive, sReg, mpc, fLive, fg, bg, mPending, mAdmitted, rpc, seals, snapshot,
          deleted, stopped>>

Sealed == seals > 0
Pending == mPending + (IF SpawnSealed /\ spc \in {"await", "child"} THEN 1 ELSE 0)

Init ==
  /\ spc = (IF HasSpawn THEN "start" ELSE "none") /\ sLive = FALSE /\ sReg = FALSE
  /\ mpc = (IF HasMigration THEN "fg" ELSE "none") /\ fLive = HasMigration /\ fg = HasMigration
  /\ bg = FALSE /\ mPending = 0 /\ mAdmitted = FALSE
  /\ rpc = "start" /\ seals = 0 /\ snapshot = {} /\ deleted = FALSE /\ stopped = FALSE

---------------------------------------------------------------------------
(* Spawn. Fix probe: refused when sealed at entry; counted as pending.     *)
SStart == /\ spc = "start"
          /\ spc' = IF SpawnSealed /\ Sealed THEN "done" ELSE "await"
          /\ UNCHANGED <<stopped, sLive, sReg, mpc, fLive, fg, bg, mPending, mAdmitted, rpc, seals,
                         snapshot, deleted>>
\* :1727 spawnProcess. Fix probe: refused if sealed once the name lock is held.
SChild == /\ spc = "await"
          /\ IF SpawnSealed /\ Sealed
               THEN spc' = "done" /\ UNCHANGED sLive
               ELSE sLive' = TRUE /\ spc' = "child"
          /\ UNCHANGED <<stopped, sReg, mpc, fLive, fg, bg, mPending, mAdmitted, rpc, seals,
                         snapshot,
                         deleted>>
SRegister == /\ spc = "child" /\ sReg' = TRUE /\ spc' = "done"   \* :1761 writeMeta, :1800 set
             /\ UNCHANGED <<stopped, sLive, mpc, fLive, fg, bg, mPending, mAdmitted, rpc, seals,
                            snapshot, deleted>>
SExit == /\ sLive /\ sLive' = FALSE                              \* the command ends by itself
         /\ UNCHANGED <<stopped, spc, sReg, mpc, fLive, fg, bg, mPending, mAdmitted, rpc, seals,
                        snapshot, deleted>>

---------------------------------------------------------------------------
(* Migration of foreground command F (bash.ts).                           *)
MBegin == /\ mpc = "fg"                                          \* :1426 beginMigration
          /\ mAdmitted' = ~Sealed /\ mPending' = mPending + 1
          /\ mpc' = IF ~Sealed THEN "claim" ELSE "refused"
          /\ UNCHANGED <<stopped, spc, sLive, sReg, fLive, fg, bg, rpc, seals, snapshot, deleted>>
MClaim == /\ mpc = "claim" /\ mpc' = "exitcheck"                 \* :1436-1443 awaited claim
          /\ UNCHANGED <<stopped, spc, sLive, sReg, fLive, fg, bg, mPending, mAdmitted, rpc, seals,
                         snapshot, deleted>>
MExitCheck == /\ mpc = "exitcheck"                               \* :1444-1468
              /\ IF ~fLive
                   THEN mpc' = "end" /\ UNCHANGED fg     \* normal completion, unregistered later
                   ELSE mpc' = "migrate" /\ fg' = FALSE  \* unregister(): in neither map now
              /\ UNCHANGED <<stopped, spc, sLive, sReg, fLive, bg, mPending, mAdmitted, rpc, seals,
                             snapshot, deleted>>
MMigrate == /\ mpc = "migrate" /\ bg' = TRUE /\ mpc' = "end"     \* :1507-1523
            /\ UNCHANGED <<stopped, spc, sLive, sReg, fLive, fg, mPending, mAdmitted, rpc, seals,
                           snapshot, deleted>>
MRefused == /\ mpc = "refused" /\ fLive' = FALSE /\ mpc' = "end" \* :1558-1567 abort + join
            /\ UNCHANGED <<stopped, spc, sLive, sReg, fg, bg, mPending, mAdmitted, rpc, seals,
                           snapshot,
                           deleted>>
MEnd == /\ mpc = "end" /\ mPending' = mPending - 1 /\ mpc' = "done"
        /\ fg' = (fg /\ fLive)                                   \* :1605 unregister on exit
        /\ UNCHANGED <<stopped, spc, sLive, sReg, fLive, bg, mAdmitted, rpc, seals, snapshot,
                       deleted>>
FExit == /\ fLive /\ fLive' = FALSE                              \* F ends by itself
         /\ fg' = FALSE /\ bg' = FALSE                           \* its owner observes the exit
         /\ UNCHANGED <<stopped, spc, sLive, sReg, mpc, mPending, mAdmitted, rpc, seals, snapshot,
                        deleted>>
---------------------------------------------------------------------------
(* Mutator.                                                                *)
\* Fixed archive: seal, cleanup (c_seal ... c_drain2) before its hooks, stop the stream, cleanup
\* again (drains migrations the seal refused meanwhile), then delete.
RStart == /\ rpc = "start"
          /\ IF Mutator = "remove" \/ ArchiveCleans
               THEN seals' = seals + 1                              \* :7378 removal seal
               ELSE UNCHANGED seals
          /\ rpc' = IF Mutator = "archive" /\ ArchiveCleans THEN "c_seal" ELSE "stop"
          /\ UNCHANGED <<stopped, spc, sLive, sReg, mpc, fLive, fg, bg, mPending, mAdmitted,
                         snapshot,
                         deleted>>
\* stopStream (:7391; archive: interruptStream, :4219) aborts the bash tool call. Its abort
\* kills a command still foreground or claiming (bash.ts:1095-1112); after unregister
\* (abortDetached, :1465) the abort is ignored by design.
RStop == /\ rpc = "stop" /\ stopped' = TRUE
         /\ rpc' = IF Mutator = "remove" \/ ArchiveCleans THEN "c_seal" ELSE "delete"
         /\ IF mpc \in {"fg", "claim", "exitcheck"} /\ fLive
              THEN fLive' = FALSE /\ fg' = FALSE /\ mpc' = IF mpc = "fg" THEN "done" ELSE mpc
              ELSE UNCHANGED <<fLive, fg, mpc>>
         /\ UNCHANGED <<spc, sLive, sReg, bg, mPending, mAdmitted, seals, snapshot, deleted>>
CSeal == /\ rpc = "c_seal" /\ seals' = seals + 1 /\ rpc' = "c_drain1"   \* cleanup :3079
         /\ UNCHANGED <<stopped, spc, sLive, sReg, mpc, fLive, fg, bg, mPending, mAdmitted,
                        snapshot,
                        deleted>>
CDrain1 == /\ rpc = "c_drain1" /\ (Pending = 0 \/ NoDrain) /\ rpc' = "c_snap"
           /\ UNCHANGED <<stopped, spc, sLive, sReg, mpc, fLive, fg, bg, mPending, mAdmitted, seals,
                          snapshot, deleted>>
CSnap == /\ rpc = "c_snap"                                       \* :3082 snapshot `processes`
         /\ snapshot' = (IF sReg THEN {"spawn"} ELSE {}) \cup (IF bg THEN {"mig"} ELSE {})
         /\ rpc' = "c_term"
         /\ UNCHANGED <<stopped, spc, sLive, sReg, mpc, fLive, fg, bg, mPending, mAdmitted, seals,
                        deleted>>
CTerm == /\ rpc = "c_term"                                       \* :3087 terminate the snapshot
         /\ sLive' = (sLive /\ "spawn" \notin snapshot)
         /\ fLive' = (fLive /\ "mig" \notin snapshot)
         /\ bg' = (bg /\ "mig" \notin snapshot)
         /\ rpc' = "c_drain2"
         /\ UNCHANGED <<stopped, spc, sReg, mpc, fg, mPending, mAdmitted, seals, snapshot, deleted>>
CDrain2 == /\ rpc = "c_drain2" /\ (Pending = 0 \/ NoDrain) /\ seals' = seals - 1
           /\ rpc' = IF stopped THEN "delete" ELSE "stop"
           /\ UNCHANGED <<stopped, spc, sLive, sReg, mpc, fLive, fg, bg, mPending, mAdmitted,
                          snapshot,
                          deleted>>
RDelete == /\ rpc = "delete" /\ deleted' = TRUE /\ rpc' = "done"  \* :7710 checkout deletion
           /\ UNCHANGED <<stopped, spc, sLive, sReg, mpc, fLive, fg, bg, mPending, mAdmitted, seals,
                          snapshot>>

Next == SStart \/ SChild \/ SRegister \/ SExit
        \/ MBegin \/ MClaim \/ MExitCheck \/ MMigrate \/ MRefused \/ MEnd \/ FExit
        \/ RStart \/ RStop \/ CSeal \/ CDrain1 \/ CSnap \/ CTerm \/ CDrain2 \/ RDelete

Spec == Init /\ [][Next]_vars

\* No process of W runs once its checkout is deleted (removal and archive both delete it).
NoLiveAfterDelete == deleted => ~sLive /\ ~fLive
\* A migrating command is never both foreground and background ...
FgBgExclusive == ~(fg /\ bg)
\* ... and while it lives, the foreground, the background or its migration block owns it.
MigrationOwned == fLive => (fg \/ bg \/ mpc \in {"claim", "exitcheck", "migrate", "refused", "end"})

TypeOK == seals \in 0..2 /\ mPending \in 0..1 /\ stopped \in BOOLEAN
=============================================================================
