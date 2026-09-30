------------------------------ MODULE FileLock ------------------------------
(***************************************************************************)
(* Model of the cross-process lock in                                     *)
(*   src/node/utils/concurrency/fileLock.ts            (acquire/reclaim)   *)
(*   src/node/utils/concurrency/processLiveness.ts     (judgeHolder)       *)
(* at commit 491bb881b5.                                                   *)
(*                                                                         *)
(* Granularity: every awaited fs syscall is one atomic action. Code        *)
(* between two awaits is folded into the action it follows. Steps that     *)
(* touch only a process-private file (temp files, its own graveyard) are   *)
(* folded into the neighbouring action, since no other process can observe *)
(* them. Each action names its source lines.                               *)
(*                                                                         *)
(* One acquisition per process slot. Several concurrent acquisitions in    *)
(* one real process behave like separate slots, except for the pid ===    *)
(* process.pid rule, which the Dead() operator models for old incarnations.*)
(*                                                                         *)
(* Environment: crash at any step (files survive, liveTokens are lost),    *)
(* restart of a slot as a new incarnation with the SAME pid (pid reuse),   *)
(* optional pre-existing crash remnants (a dead lock and/or dead guard),   *)
(* optional release-unlink failure, optional older-build lease judge.      *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
  Slots,          \* process slots (pids), e.g. {1,2,3}
  MaxTok,         \* bound on minted tokens (bounds retries)
  MaxInc,         \* bound on incarnations per slot (bounds crash/restart)
  Linux,          \* TRUE: /proc starttime proves pid reuse (judgeHolder rule 3)
  CanCrash,       \* environment may crash processes
  InitStaleLock,  \* start with a lock left by a dead process
  InitStaleGuard, \* start with a reclaim guard left by a dead process
  ReleaseFault,   \* releaseFileLock's unlink may fail (EBUSY/EPERM/EIO)
  OldLease,       \* slots running an older build that lease-breaks any holder
  NoReread        \* MUTATION: drop the under-guard re-read (fileLock.ts:458-461)

Ghost == 0        \* pid of a process that died before the model starts
All == Slots \cup {Ghost}
None == <<>>
\* A token is <<pid, incarnation, serial>>; serial makes the nonce unique.
GhostLock == <<Ghost, 0, 1>>
GhostGuard == <<Ghost, 0, 2>>

OwnerPcs == {"cs", "as", "mu"}    \* the process believes it holds the lock

VARIABLES
  lock,    \* content of lockPath (None = absent)
  guard,   \* content of lockPath.reclaim
  grave,   \* records preserved in .stale-* graveyards (evidence only)
  alive, inc,
  live,    \* per slot: the liveTokens set (fileLock.ts:118)
  pc,
  lt,      \* lock token of the current acquisition
  gt,      \* guard token of the current withReclaimGuard call
  obs,     \* observed lock token (fileLock.ts:442)
  gobs,    \* observed guard token (fileLock.ts:407)
  gy,      \* record held in this reclaimer's graveyard
  ntok,
  badRename, badRelease, badGuardUnlink, badGuardRelease

vars == <<lock, guard, grave, alive, inc, live, pc, lt, gt, obs, gobs, gy,
          ntok, badRename, badRelease, badGuardUnlink, badGuardRelease>>
flags == <<badRename, badRelease, badGuardUnlink, badGuardRelease>>

\* The token's writer is alive and may still write it (ground truth).
TrulyLive(t) == alive[t[1]] /\ inc[t[1]] = t[2] /\ t \in live[t[1]]

(* judgeHolder(holder, liveTokens.has(token)) as seen by slot s,           *)
(* processLiveness.ts:208-254, same PID domain, well-formed token.        *)
Judge(s, t) ==
  LET o == t[1] IN
  IF o = s THEN t \notin live[s]            \* :237-238 pid === process.pid
  ELSE IF ~alive[o] THEN TRUE               \* :240 ESRCH
  ELSE IF Linux THEN inc[o] # t[2]          \* :249-253 starttime differs
  ELSE FALSE                                \* :243-244 live pid, no birth proof

\* Verdicts slot s may reach. An older build (#4480 item 3) may also
\* lease-break a holder whose birth it cannot prove (a stalled holder).
Verdicts(s, t) == IF s \in OldLease THEN {Judge(s, t), TRUE} ELSE {Judge(s, t)}

Mint(s) == <<s, inc[s], ntok>>

Init ==
  /\ lock = IF InitStaleLock THEN GhostLock ELSE None
  /\ guard = IF InitStaleGuard THEN GhostGuard ELSE None
  /\ grave = {}
  /\ alive = [x \in All |-> x # Ghost]
  /\ inc = [x \in All |-> IF x = Ghost THEN 0 ELSE 1]
  /\ live = [x \in All |-> {}]
  /\ pc = [x \in Slots |-> "idle"]
  /\ lt = [x \in Slots |-> None]
  /\ gt = [x \in Slots |-> None]
  /\ obs = [x \in Slots |-> None]
  /\ gobs = [x \in Slots |-> None]
  /\ gy = [x \in Slots |-> None]
  /\ ntok = 3
  /\ badRename = FALSE /\ badRelease = FALSE
  /\ badGuardUnlink = FALSE /\ badGuardRelease = FALSE

Go(s, to) == pc' = [pc EXCEPT ![s] = to]
Retire(s, t) == live' = [live EXCEPT ![s] = @ \ {t}]

\* fileLock.ts:221-227 makeOwnershipToken (liveTokens.add) + temp write.
Start(s) ==
  /\ pc[s] = "idle" /\ ntok < MaxTok
  /\ lt' = [lt EXCEPT ![s] = Mint(s)]
  /\ live' = [live EXCEPT ![s] = @ \cup {Mint(s)}]
  /\ ntok' = ntok + 1
  /\ Go(s, "link")
  /\ UNCHANGED <<lock, guard, grave, alive, inc, gt, obs, gobs, gy, flags>>

\* fileLock.ts:230 fs.link(temp, lockPath); EEXIST falls through to :265.
Link(s) ==
  /\ pc[s] = "link"
  /\ IF lock = None
       THEN lock' = lt[s] /\ Go(s, "cs")
       ELSE UNCHANGED lock /\ Go(s, "rd")
  /\ UNCHANGED <<guard, grave, alive, inc, live, lt, gt, obs, gobs, gy, ntok, flags>>

\* fileLock.ts:442 readFile(lockPath); ENOENT returns to the poll loop.
Read(s) ==
  /\ pc[s] = "rd"
  /\ IF lock = None
       THEN Go(s, "sleep") /\ UNCHANGED obs
       ELSE obs' = [obs EXCEPT ![s] = lock] /\ Go(s, "jd")
  /\ UNCHANGED <<lock, guard, grave, alive, inc, live, lt, gt, gobs, gy, ntok, flags>>

\* fileLock.ts:446 judgeLockToken; dead => :397-399 mint guard token + temp.
JudgeLock(s) ==
  /\ pc[s] = "jd"
  /\ \E dead \in Verdicts(s, obs[s]) :
       IF dead
         THEN /\ ntok < MaxTok
              /\ gt' = [gt EXCEPT ![s] = Mint(s)]
              /\ live' = [live EXCEPT ![s] = @ \cup {Mint(s)}]
              /\ ntok' = ntok + 1
              /\ Go(s, "glink")
         ELSE Go(s, "sleep") /\ UNCHANGED <<gt, live, ntok>>
  /\ UNCHANGED <<lock, guard, grave, alive, inc, lt, obs, gobs, gy, flags>>

\* fileLock.ts:402 fs.link(temp, guardPath).
GuardLink(s) ==
  /\ pc[s] = "glink"
  /\ IF guard = None
       THEN guard' = gt[s] /\ Go(s, "reread")
       ELSE UNCHANGED guard /\ Go(s, "grd")
  /\ UNCHANGED <<lock, grave, alive, inc, live, lt, gt, obs, gobs, gy, ntok, flags>>

\* fileLock.ts:407-408 readFile(guardPath); null => return (finally :425).
GuardRead(s) ==
  /\ pc[s] = "grd"
  /\ IF guard = None
       THEN Retire(s, gt[s]) /\ Go(s, "sleep") /\ UNCHANGED gobs
       ELSE gobs' = [gobs EXCEPT ![s] = guard] /\ Go(s, "gjd") /\ UNCHANGED live
  /\ UNCHANGED <<lock, guard, grave, alive, inc, lt, gt, obs, gy, ntok, flags>>

\* fileLock.ts:409-416 judge the guard holder; busy => return blocker.
GuardJudge(s) ==
  /\ pc[s] = "gjd"
  /\ \E dead \in Verdicts(s, gobs[s]) :
       IF dead THEN Go(s, "gunl") /\ UNCHANGED live
       ELSE Retire(s, gt[s]) /\ Go(s, "sleep")
  /\ UNCHANGED <<lock, guard, grave, alive, inc, lt, gt, obs, gobs, gy, ntok, flags>>

\* fileLock.ts:411 UNCONDITIONAL unlink(guardPath) of the judged-stale guard,
\* then return (finally :425 retires gt). Removes whatever guard is there now.
GuardUnlinkStale(s) ==
  /\ pc[s] = "gunl"
  /\ guard' = None
  /\ badGuardUnlink' = (badGuardUnlink \/ (guard # None /\ TrulyLive(guard)))
  /\ Retire(s, gt[s]) /\ Go(s, "sleep")
  /\ UNCHANGED <<lock, grave, alive, inc, lt, gt, obs, gobs, gy, ntok,
                 badRename, badRelease, badGuardRelease>>

\* fileLock.ts:458-461 verify-before-displace re-read (mutation: skipped).
Reread(s) ==
  /\ pc[s] = "reread"
  /\ IF ~NoReread /\ lock # obs[s] THEN Go(s, "grel") ELSE Go(s, "ren")
  /\ UNCHANGED <<lock, guard, grave, alive, inc, live, lt, gt, obs, gobs, gy, ntok, flags>>

\* fileLock.ts:464 rename(lockPath, graveyard) + :468 read of the private
\* graveyard; :495 unlink of the private graveyard when it held `observed`.
Rename(s) ==
  /\ pc[s] = "ren"
  /\ IF lock = None
       THEN Go(s, "grel") /\ UNCHANGED <<lock, gy, badRename>>
       ELSE /\ lock' = None
            /\ badRename' = (badRename \/ TrulyLive(lock))
            /\ IF lock = obs[s]
                 THEN Go(s, "grel") /\ UNCHANGED gy
                 ELSE gy' = [gy EXCEPT ![s] = lock] /\ Go(s, "restore")
  /\ UNCHANGED <<guard, grave, alive, inc, live, lt, gt, obs, gobs, ntok,
                 badRelease, badGuardUnlink, badGuardRelease>>

\* fileLock.ts:477 link(graveyard, lockPath); EEXIST => preserve (:479-489).
Restore(s) ==
  /\ pc[s] = "restore"
  /\ IF lock = None
       THEN lock' = gy[s] /\ UNCHANGED grave
       ELSE grave' = grave \cup {gy[s]} /\ UNCHANGED lock
  /\ gy' = [gy EXCEPT ![s] = None]
  /\ Go(s, "grel")
  /\ UNCHANGED <<guard, alive, inc, live, lt, gt, obs, gobs, ntok, flags>>

\* fileLock.ts:421 -> :502 releaseFileLock(guard) read; mismatch => leave.
GuardRelRead(s) ==
  /\ pc[s] = "grel"
  /\ IF guard = gt[s] THEN Go(s, "gunl2") /\ UNCHANGED live
     ELSE Retire(s, gt[s]) /\ Go(s, "sleep")
  /\ UNCHANGED <<lock, guard, grave, alive, inc, lt, gt, obs, gobs, gy, ntok, flags>>

\* fileLock.ts:507 unlink(guardPath), then :425 liveTokens.delete.
GuardRelUnlink(s) ==
  /\ pc[s] = "gunl2"
  /\ \/ /\ guard' = None
        /\ badGuardRelease' = (badGuardRelease \/ (guard # None /\ guard # gt[s]))
     \/ /\ ReleaseFault          \* unlink failed; :509 only logs
        /\ UNCHANGED <<guard, badGuardRelease>>
  /\ Retire(s, gt[s]) /\ Go(s, "sleep")
  /\ UNCHANGED <<lock, grave, alive, inc, lt, gt, obs, gobs, gy, ntok,
                 badRename, badRelease, badGuardUnlink>>

\* fileLock.ts:266-273 deadline check + sleep; timeout => finally :277.
Sleep(s) ==
  /\ pc[s] = "sleep"
  /\ \/ Go(s, "link") /\ UNCHANGED live
     \/ Retire(s, lt[s]) /\ Go(s, "idle")
  /\ UNCHANGED <<lock, guard, grave, alive, inc, lt, gt, obs, gobs, gy, ntok, flags>>

\* Critical section: fileLock.ts:304 assertStillOwned read, then the
\* irreversible mutation it protects ("mu").
Assert(s) ==
  /\ pc[s] = "cs"
  /\ Go(s, "as")
  /\ UNCHANGED <<lock, guard, grave, alive, inc, live, lt, gt, obs, gobs, gy, ntok, flags>>
AssertRead(s) ==
  /\ pc[s] = "as"
  /\ IF lock = lt[s] THEN Go(s, "mu") ELSE Go(s, "rr")   \* throw => dispose
  /\ UNCHANGED <<lock, guard, grave, alive, inc, live, lt, gt, obs, gobs, gy, ntok, flags>>
Mutate(s) ==
  /\ pc[s] = "mu"
  /\ Go(s, "cs")
  /\ UNCHANGED <<lock, guard, grave, alive, inc, live, lt, gt, obs, gobs, gy, ntok, flags>>

\* fileLock.ts:249-257 dispose -> :502 releaseFileLock read.
Release(s) ==
  /\ pc[s] = "cs"
  /\ Go(s, "rr")
  /\ UNCHANGED <<lock, guard, grave, alive, inc, live, lt, gt, obs, gobs, gy, ntok, flags>>
RelRead(s) ==
  /\ pc[s] = "rr"
  /\ IF lock = lt[s] THEN Go(s, "ru") /\ UNCHANGED live
     ELSE Retire(s, lt[s]) /\ Go(s, "idle")     \* mismatch or ENOENT: leave
  /\ UNCHANGED <<lock, guard, grave, alive, inc, lt, gt, obs, gobs, gy, ntok, flags>>
\* fileLock.ts:507 unlink(lockPath), then :257 liveTokens.delete.
RelUnlink(s) ==
  /\ pc[s] = "ru"
  /\ \/ /\ lock' = None
        /\ badRelease' = (badRelease \/ (lock # None /\ lock # lt[s]))
     \/ /\ ReleaseFault
        /\ UNCHANGED <<lock, badRelease>>
  /\ Retire(s, lt[s]) /\ Go(s, "idle")
  /\ UNCHANGED <<guard, grave, alive, inc, lt, gt, obs, gobs, gy, ntok,
                 badRename, badGuardUnlink, badGuardRelease>>

\* Environment: SIGKILL at any step. Files survive; a held graveyard record
\* stays on disk as a .stale-* file.
Crash(s) ==
  /\ CanCrash /\ alive[s]
  /\ alive' = [alive EXCEPT ![s] = FALSE]
  /\ live' = [live EXCEPT ![s] = {}]
  /\ grave' = IF gy[s] # None THEN grave \cup {gy[s]} ELSE grave
  /\ gy' = [gy EXCEPT ![s] = None]
  /\ Go(s, "dead")
  /\ UNCHANGED <<lock, guard, inc, lt, gt, obs, gobs, ntok, flags>>

\* Environment: the pid is reused by a new Xum process (new birth).
Restart(s) ==
  /\ ~alive[s] /\ inc[s] < MaxInc
  /\ alive' = [alive EXCEPT ![s] = TRUE]
  /\ inc' = [inc EXCEPT ![s] = @ + 1]
  /\ Go(s, "idle")
  /\ UNCHANGED <<lock, guard, grave, live, lt, gt, obs, gobs, gy, ntok, flags>>

Step(s) ==
  \/ Start(s) \/ Link(s) \/ Read(s) \/ JudgeLock(s) \/ GuardLink(s)
  \/ GuardRead(s) \/ GuardJudge(s) \/ GuardUnlinkStale(s) \/ Reread(s)
  \/ Rename(s) \/ Restore(s) \/ GuardRelRead(s) \/ GuardRelUnlink(s)
  \/ Sleep(s) \/ Assert(s) \/ AssertRead(s) \/ Mutate(s) \/ Release(s)
  \/ RelRead(s) \/ RelUnlink(s)

Next == \E s \in Slots : (alive[s] /\ Step(s)) \/ Crash(s) \/ Restart(s)

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* Properties *)

\* Header claim (fileLock.ts:32): at most one process believes it owns.
MutualExclusion ==
  \A a, b \in Slots : (a # b /\ pc[a] \in OwnerPcs) => pc[b] \notin OwnerPcs

\* Header claim (fileLock.ts:35-38): commit-point assertStillOwned makes
\* displacement harmless, i.e. two processes never pass it concurrently.
CommitExclusion ==
  \A a, b \in Slots : (a # b /\ pc[a] = "mu") => pc[b] # "mu"

\* A live holder is never displaced (fileLock.ts:11-17, :33).
NoReclaimFromLiveHolder == ~badRename

\* Release never removes another owner's lock or guard (fileLock.ts:29-30).
ReleaseOwnOnly == ~badRelease /\ ~badGuardRelease

\* Diagnostic: the stale-guard unlink (:411) never removes a live guard.
StaleGuardUnlinkSafe == ~badGuardUnlink

\* Wedge proxy: no lock/guard record that nobody owns yet some live process
\* refuses to reclaim. Such a record blocks every other process until its
\* pid exits (judgeHolder never ages out a live pid).
Orphaned(t) ==
  /\ t # None /\ ~TrulyLive(t)
  /\ \E s \in Slots \ OldLease : alive[s] /\ ~Judge(s, t)
NoOrphanLock == ~Orphaned(lock)
NoOrphanGuard == ~Orphaned(guard)

TypeOK ==
  /\ pc \in [Slots -> {"idle", "link", "rd", "jd", "glink", "grd", "gjd", "gunl",
                        "reread", "ren", "restore", "grel", "gunl2", "sleep",
                        "cs", "as", "mu", "rr", "ru", "dead"}]
  /\ ntok <= MaxTok
=============================================================================
