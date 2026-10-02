--------------------------- MODULE PlanMigration ---------------------------
(***************************************************************************)
(* Reduced design for installation-scoped SSH plans (#5174): a one-shot,  *)
(* one-way migration instead of a fallback that stays open to every read. *)
(*                                                                         *)
(* Files on the SSH host (this build never writes, moves or deletes the    *)
(* two legacy files):                                                      *)
(*   idFile  ~/.mux/plans/<workspace id>.md: this row's own oldest plan.   *)
(*   shared  ~/.mux/plans/<basename>/<name>.md: pre-#5174 path that other  *)
(*           installations may also use ("F" = a foreign write).          *)
(*   scoped  ~/.mux/plans/installation-<uuid>/...: one file per identity   *)
(*           (a reset of the identity file starts a new, empty namespace). *)
(* Local, durable: the row flag `migrated` (config.json; older builds keep *)
(* it untouched), and the identity (installationIdentity.ts).             *)
(*                                                                         *)
(* Every plan access resolves the location first; for an unmigrated row   *)
(* that runs the migration once, under the row's lock:                    *)
(*   probe   migrated? -> use scoped. Else take the lock.                 *)
(*   copy    re-check the flag; source = idFile if present, else shared;  *)
(*           unless scoped exists: write temp, fsync temp, link to scoped *)
(*   sync    fsync the scoped directory                                    *)
(*   retire  persist migrated = TRUE (whatever the source was), unlock    *)
(*   deliver read scoped only                                              *)
(* A clear retires (under the lock), then deletes scoped only.            *)
(* Crash: a backend restart aborts the actor's current operation and      *)
(* releases its lock. PowerLoss: one host power cut; directory entries    *)
(* not yet fsynced vanish.                                                 *)
(***************************************************************************)
EXTENDS Naturals, Sequences

CONSTANTS
  Actors,      \* subset of {"a", "b", "c", "f", "r", "o"}
  InitId,      \* initial idFile values
  InitShared,  \* initial shared values
  MaxCrashes,  \* backend restarts
  PowerLoss,   \* allow one host power cut
  Mutant       \* "none" or a mutation that must be caught

None == "none"
Legacy == {"I", "L", "F", "O"}   \* I id plan, L own shared plan, F foreign, O older-build edit
Contents == {None, "E"} \cup Legacy  \* E: an empty file left by a power cut
Ids == {1, 2}
NoRetire == [i |-> 0, hadLegacy |-> FALSE]

M(m) == Mutant = m
\* pr5469: #5469's ID branch (move the id plan, leave the shared fallback open).
\* idNoRetire: an id-sourced migration skips the retirement.
\* sharedFirst: the shared path takes precedence over the id plan.
\* lazyFallback: a read that finds no scoped plan reads the legacy files.
\* moveSource: the migration moves its source instead of copying it.
\* unlocked: no lock and no re-check of the flag.
\* retireBeforeSync: the flag lands before the directory fsync.
\* syncAfterLink: link, then fsync (a power cut can leave an empty scoped file).

Script == [x \in {"a", "b", "c", "f", "r", "o"} |->
             CASE x = "a" -> <<"read", "read", "read">>
               [] x = "b" -> <<"read">>
               [] x = "c" -> <<"clear">>
               [] x = "f" -> <<"fwrite">>
               [] x = "r" -> <<"reset">>
               [] x = "o" -> <<"omove", "owrite">>]

Steps == [read |-> IF M("retireBeforeSync")
                   THEN <<"probe", "lock", "copy", "retire", "sync", "deliver">>
                   ELSE <<"probe", "lock", "copy", "sync", "retire", "deliver">>,
          clear |-> <<"retire", "del">>,
          fwrite |-> <<"do">>, reset |-> <<"do">>, omove |-> <<"do">>, owrite |-> <<"do">>]

VARIABLES
  pc, sub, crashes, powerCut,
  idFile, shared, scoped, synced, id, migrated, lock,
  myId, srcKind,   \* per actor: identity captured at probe; what its copy used
  sawSrc,          \* per actor: its copy step found a legacy source
  \* ghosts
  migDone,         \* some migration or clear retired the row (as the code believes)
  idSeen,          \* this build has seen the row's id plan
  oldMovedId,      \* an older build moved the id plan onto the shared path
  retiredAt,       \* [i, hadLegacy] at the retirement that set the flag
  clearStarted, cleared, clearedId,
  reactivated,     \* a legacy file was consulted after the row retired
  foreignOverId,   \* the shared file was copied while an id plan existed
  foreignAfterId,  \* foreign content adopted after this build saw the id plan
  resurrected,     \* legacy content delivered after a completed clear
  legacyTouched

vars == <<pc, sub, crashes, powerCut, idFile, shared, scoped, synced, id, migrated, lock, myId,
          srcKind, sawSrc, migDone, idSeen, oldMovedId, retiredAt, clearStarted, cleared, clearedId,
          reactivated, foreignOverId, foreignAfterId, resurrected, legacyTouched>>

TypeOK ==
  /\ idFile \in Contents /\ shared \in Contents
  /\ scoped \in [Ids -> Contents] /\ synced \in [Ids -> BOOLEAN]
  /\ id \in Ids /\ migrated \in BOOLEAN /\ lock \in {None} \cup Actors
  /\ srcKind \in [Actors -> {"none", "id", "shared"}]

Init ==
  /\ pc = [x \in Actors |-> 1] /\ sub = [x \in Actors |-> 1]
  /\ crashes = 0 /\ powerCut = FALSE
  /\ idFile \in InitId /\ shared \in InitShared
  /\ scoped = [i \in Ids |-> None] /\ synced = [i \in Ids |-> TRUE]
  /\ id = 1 /\ migrated = FALSE /\ lock = None
  /\ myId = [x \in Actors |-> 1] /\ srcKind = [x \in Actors |-> "none"]
  /\ sawSrc = [x \in Actors |-> FALSE]
  /\ migDone = FALSE /\ idSeen = FALSE /\ oldMovedId = FALSE /\ retiredAt = NoRetire
  /\ clearStarted = FALSE /\ cleared = FALSE /\ clearedId = 1
  /\ reactivated = FALSE /\ foreignOverId = FALSE /\ foreignAfterId = FALSE
  /\ resurrected = FALSE /\ legacyTouched = FALSE

Active(x) == pc[x] <= Len(Script[x])
Op(x) == Script[x][pc[x]]
Step(x) == Steps[Op(x)][sub[x]]

Advance(x, done) ==
  IF done \/ sub[x] = Len(Steps[Op(x)])
  THEN /\ pc' = [pc EXCEPT ![x] = pc[x] + 1]
       /\ sub' = [sub EXCEPT ![x] = 1]
  ELSE /\ sub' = [sub EXCEPT ![x] = sub[x] + 1]
       /\ UNCHANGED pc

Release(x) == lock' = IF lock = x THEN None ELSE lock
Deliver(v) == resurrected' = (resurrected \/ (cleared /\ v \in Legacy))

ReadProbe(x) ==
  IF migrated
  THEN /\ Deliver(scoped[id])
       /\ Advance(x, TRUE)
       /\ UNCHANGED <<crashes, powerCut, idFile, shared, scoped, synced, id, migrated, lock,
                      myId, srcKind, sawSrc, migDone, idSeen, oldMovedId, retiredAt, clearStarted,
                      cleared, clearedId, reactivated, foreignOverId, foreignAfterId,
                      legacyTouched>>
  ELSE /\ myId' = [myId EXCEPT ![x] = id]
       /\ Advance(x, FALSE)
       /\ UNCHANGED <<crashes, powerCut, idFile, shared, scoped, synced, id, migrated, lock,
                      srcKind, sawSrc, migDone, idSeen, oldMovedId, retiredAt, clearStarted, cleared,
                      clearedId, reactivated, foreignOverId, foreignAfterId, resurrected,
                      legacyTouched>>

ReadLock(x) ==
  /\ IF M("unlocked") THEN UNCHANGED lock ELSE (lock = None /\ lock' = x)
  /\ Advance(x, FALSE)
  /\ UNCHANGED <<crashes, powerCut, idFile, shared, scoped, synced, id, migrated, myId, srcKind, sawSrc,
                 migDone, idSeen, oldMovedId, retiredAt, clearStarted, cleared, clearedId,
                 reactivated, foreignOverId, foreignAfterId, resurrected, legacyTouched>>

ReadCopy(x) ==
  LET i == myId[x]
      useShared == IF M("sharedFirst") THEN shared # None ELSE idFile = None
      src == IF useShared THEN shared ELSE idFile
      kind == IF src = None THEN "none" ELSE IF useShared THEN "shared" ELSE "id"
      copies == scoped[i] = None /\ src # None
      moves == copies /\ (M("moveSource") \/ (M("pr5469") /\ kind = "id")) IN
  IF ~M("unlocked") /\ migrated
  THEN \* Another backend or a clear retired the row since the probe.
       /\ Release(x)
       /\ Deliver(scoped[id])
       /\ Advance(x, TRUE)
       /\ UNCHANGED <<crashes, powerCut, idFile, shared, scoped, synced, id, migrated, myId,
                      srcKind, sawSrc, migDone, idSeen, oldMovedId, retiredAt, clearStarted, cleared,
                      clearedId, reactivated, foreignOverId, foreignAfterId, legacyTouched>>
  ELSE /\ reactivated' = (reactivated \/ migDone)
       /\ idSeen' = (idSeen \/ idFile # None)
       /\ foreignOverId' = (foreignOverId \/ (copies /\ kind = "shared" /\ idFile # None))
       /\ foreignAfterId' = (foreignAfterId \/
                             (copies /\ src = "F" /\ (idSeen \/ idFile # None) /\ ~oldMovedId))
       /\ scoped' = IF copies THEN [scoped EXCEPT ![i] = src] ELSE scoped
       /\ synced' = IF copies THEN [synced EXCEPT ![i] = FALSE] ELSE synced
       /\ srcKind' = [srcKind EXCEPT ![x] = IF copies THEN kind ELSE "none"]
       /\ sawSrc' = [sawSrc EXCEPT ![x] = src # None]
       /\ idFile' = IF moves /\ kind = "id" THEN None ELSE idFile
       /\ shared' = IF moves /\ kind = "shared" THEN None ELSE shared
       /\ legacyTouched' = (legacyTouched \/ moves)
       /\ Advance(x, FALSE)
       /\ UNCHANGED <<crashes, powerCut, id, migrated, lock, myId, migDone, oldMovedId, retiredAt,
                      clearStarted, cleared, clearedId, resurrected>>

ReadSync(x) ==
  /\ synced' = [synced EXCEPT ![myId[x]] = TRUE]
  /\ Advance(x, FALSE)
  /\ UNCHANGED <<crashes, powerCut, idFile, shared, scoped, id, migrated, lock, myId, srcKind, sawSrc,
                 migDone, idSeen, oldMovedId, retiredAt, clearStarted, cleared, clearedId,
                 reactivated, foreignOverId, foreignAfterId, resurrected, legacyTouched>>

ReadRetire(x) ==
  LET skip == (M("idNoRetire") \/ M("pr5469")) /\ srcKind[x] = "id" IN
  /\ migrated' = (migrated \/ ~skip)
  /\ migDone' = TRUE
  /\ retiredAt' = IF ~migrated /\ ~skip
                  THEN [i |-> myId[x], hadLegacy |-> sawSrc[x]]
                  ELSE retiredAt
  /\ Release(x)
  /\ Advance(x, FALSE)
  /\ UNCHANGED <<crashes, powerCut, idFile, shared, scoped, synced, id, myId, srcKind, sawSrc, idSeen,
                 oldMovedId, clearStarted, cleared, clearedId, reactivated, foreignOverId,
                 foreignAfterId, resurrected, legacyTouched>>

ReadDeliver(x) ==
  LET v == scoped[myId[x]]
      lazy == M("lazyFallback") /\ v = None
      w == IF lazy THEN (IF idFile # None THEN idFile ELSE shared) ELSE v IN
  /\ Deliver(w)
  /\ reactivated' = (reactivated \/ (lazy /\ migDone))
  /\ Advance(x, FALSE)
  /\ UNCHANGED <<crashes, powerCut, idFile, shared, scoped, synced, id, migrated, lock, myId,
                 srcKind, sawSrc, migDone, idSeen, oldMovedId, retiredAt, clearStarted, cleared,
                 clearedId, foreignOverId, foreignAfterId, legacyTouched>>

ClearRetire(x) ==
  /\ lock = None   \* taken and released within the step
  /\ migrated' = TRUE /\ migDone' = TRUE /\ clearStarted' = TRUE
  /\ myId' = [myId EXCEPT ![x] = id]
  /\ retiredAt' = IF migrated THEN retiredAt
                  ELSE [i |-> id, hadLegacy |-> FALSE]
  /\ Advance(x, FALSE)
  /\ UNCHANGED <<crashes, powerCut, idFile, shared, scoped, synced, id, lock, srcKind, sawSrc, idSeen,
                 oldMovedId, cleared, clearedId, reactivated, foreignOverId, foreignAfterId,
                 resurrected, legacyTouched>>

ClearDel(x) ==
  /\ scoped' = [scoped EXCEPT ![myId[x]] = None]
  /\ synced' = [synced EXCEPT ![myId[x]] = TRUE]
  /\ cleared' = TRUE /\ clearedId' = myId[x]
  /\ Advance(x, FALSE)
  /\ UNCHANGED <<crashes, powerCut, idFile, shared, id, migrated, lock, myId, srcKind, sawSrc, migDone,
                 idSeen, oldMovedId, retiredAt, clearStarted, reactivated, foreignOverId,
                 foreignAfterId, resurrected, legacyTouched>>

\* Environment: another installation writes the shared file; the user resets the identity; an
\* older build of this installation (a downgrade) moves the id plan onto the shared path when that
\* path is empty (pre-#5174 readPlanFile), then edits the plan there. It ignores `migrated`.
Env(x) ==
  /\ CASE Op(x) = "fwrite" -> shared' = "F" /\ UNCHANGED <<idFile, id, oldMovedId>>
       [] Op(x) = "reset" ->
            \* The documented reset deletes the identity file while Xum is stopped: no operation
            \* (and so no identity read once per operation) spans it.
            /\ \A y \in Actors : sub[y] = 1
            /\ id' = 2 /\ UNCHANGED <<idFile, shared, oldMovedId>>
       [] Op(x) = "omove" ->
            IF shared = None /\ idFile # None
            THEN shared' = idFile /\ idFile' = None /\ oldMovedId' = TRUE /\ UNCHANGED id
            ELSE UNCHANGED <<idFile, shared, id, oldMovedId>>
       [] Op(x) = "owrite" -> shared' = "O" /\ UNCHANGED <<idFile, id, oldMovedId>>
  /\ Advance(x, FALSE)
  /\ UNCHANGED <<crashes, powerCut, scoped, synced, migrated, lock, myId, srcKind, sawSrc, migDone, idSeen,
                 retiredAt, clearStarted, cleared, clearedId, reactivated, foreignOverId,
                 foreignAfterId, resurrected, legacyTouched>>

Exec(x) ==
  /\ Active(x)
  /\ CASE Op(x) = "read" /\ Step(x) = "probe" -> ReadProbe(x)
       [] Op(x) = "read" /\ Step(x) = "lock" -> ReadLock(x)
       [] Op(x) = "read" /\ Step(x) = "copy" -> ReadCopy(x)
       [] Op(x) = "read" /\ Step(x) = "sync" -> ReadSync(x)
       [] Op(x) = "read" /\ Step(x) = "retire" -> ReadRetire(x)
       [] Op(x) = "read" /\ Step(x) = "deliver" -> ReadDeliver(x)
       [] Op(x) = "clear" /\ Step(x) = "retire" -> ClearRetire(x)
       [] Op(x) = "clear" /\ Step(x) = "del" -> ClearDel(x)
       [] OTHER -> Env(x)

\* A backend restart aborts x's current operation (between any two writes) and frees its lock.
Crash(x) ==
  /\ crashes < MaxCrashes
  /\ Active(x) /\ sub[x] > 1 /\ Op(x) \in {"read", "clear"}
  /\ crashes' = crashes + 1
  /\ pc' = [pc EXCEPT ![x] = pc[x] + 1] /\ sub' = [sub EXCEPT ![x] = 1]
  /\ Release(x)
  /\ UNCHANGED <<powerCut, idFile, shared, scoped, synced, id, migrated, myId, srcKind, sawSrc, migDone,
                 idSeen, oldMovedId, retiredAt, clearStarted, cleared, clearedId, reactivated,
                 foreignOverId, foreignAfterId, resurrected, legacyTouched>>

\* A host power cut: un-fsynced directory entries vanish; with syncAfterLink the inode's data may
\* be lost too, leaving an empty file. Every in-flight operation aborts.
Cut ==
  /\ PowerLoss /\ ~powerCut
  /\ powerCut' = TRUE
  /\ \E lost \in (IF M("syncAfterLink") THEN {None, "E"} ELSE {None}) :
       scoped' = [i \in Ids |-> IF synced[i] THEN scoped[i] ELSE lost]
  /\ synced' = [i \in Ids |-> TRUE]
  /\ pc' = [x \in Actors |-> IF Active(x) /\ sub[x] > 1 THEN pc[x] + 1 ELSE pc[x]]
  /\ sub' = [x \in Actors |-> 1]
  /\ lock' = None
  /\ UNCHANGED <<crashes, idFile, shared, id, migrated, myId, srcKind, sawSrc, migDone, idSeen,
                 oldMovedId, retiredAt, clearStarted, cleared, clearedId, reactivated,
                 foreignOverId, foreignAfterId, resurrected, legacyTouched>>

Next == (\E x \in Actors : Exec(x) \/ Crash(x)) \/ Cut

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* Invariants. *)

\* One-way: once the row retired, no read consults a legacy file again, even after an identity
\* reset leaves the scoped namespace empty.
NoReactivation == ~reactivated

\* An existing id plan beats the shared basename path.
IdPrecedence == ~foreignOverId

\* The reported sequence (#5469 r9): once this build saw the row's id plan it never adopts another
\* installation's shared plan. (An older build that moved the id plan onto the shared path first
\* makes the two indistinguishable; see the product question.)
NoForeignAfterId == ~foreignAfterId

\* The flag retires only once the plan it migrated is durable in the scoped namespace.
NoLostPlan ==
  (retiredAt # NoRetire /\ retiredAt.hadLegacy /\ ~clearStarted) => scoped[retiredAt.i] \in Legacy

\* After a completed clear no read hands this workspace legacy content, nothing restores it.
NoResurrection == ~resurrected /\ ~(cleared /\ scoped[clearedId] \in Legacy)

\* This build never moves, deletes or writes either legacy file.
NoLegacyTouch == ~legacyTouched
=============================================================================
