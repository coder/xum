------------------------------ MODULE FileLock ------------------------------
(***************************************************************************)
(* Model of the cross-process lock in                                     *)
(*   src/node/utils/concurrency/fileLock.ts            (acquire/reclaim)   *)
(*   src/node/utils/concurrency/processLiveness.ts     (judgeHolder)       *)
(* after the stale-guard / release-retry fix.                              *)
(*                                                                         *)
(* Granularity: every awaited fs syscall is one atomic action. Code        *)
(* between two awaits is folded into the action it follows. Steps that     *)
(* touch only a process-private file (temp files, its own graveyard) are   *)
(* folded into the neighbouring action, since no other process can observe *)
(* them. Each action names the code it models.                             *)
(*                                                                         *)
(* Files: f[0] is lockPath, f[k] (k >= 1) its k-th nested reclaim guard    *)
(* (lockPath + k times ".reclaim"). reclaimStaleFileLock(depth k) reclaims *)
(* f[k] under the guard f[k+1]; a dead guard found while linking f[k+1] is *)
(* reclaimed the same way one level up (withReclaimGuard's EEXIST branch   *)
(* calls reclaimStaleFileLock(guard, k+1)). At k = Depth (MAX_RECLAIM_DEPTH*)
(* in the code) a dead record is refused: reclamation fails closed.        *)
(* The recursion only ever returns to the poll loop after the nested call, *)
(* so one current level lv per process replaces a call stack.              *)
(*                                                                         *)
(* One acquisition per process slot. Several concurrent acquisitions in    *)
(* one real process behave like separate slots, except for the pid ===    *)
(* process.pid rule, which the Dead() operator models for old incarnations.*)
(*                                                                         *)
(* Environment: crash at any step (files survive, liveTokens are lost),    *)
(* restart of a slot as a new incarnation with the SAME pid (pid reuse),   *)
(* optional pre-existing crash remnants (a dead lock and/or dead guard),   *)
(* optional transient release-unlink failures, optional older-build lease  *)
(* judge (verdicts only: OldLease slots still run this protocol).          *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
  Slots,          \* process slots (pids), e.g. {1,2,3}
  MaxTok,         \* bound on minted tokens (bounds retries)
  MaxInc,         \* bound on incarnations per slot (bounds crash/restart)
  Depth,          \* MAX_RECLAIM_DEPTH: files f[0..Depth]
  Linux,          \* TRUE: /proc starttime proves pid reuse (judgeHolder rule 3)
  CanCrash,       \* environment may crash processes
  InitStaleLock,  \* start with a lock left by a dead process
  InitStaleGuard, \* start with a reclaim guard left by a dead process
  ReleaseFault,   \* consecutive release-unlink failures per release (EBUSY/EPERM)
  OldLease,       \* slots running an older build that lease-breaks any holder
  NoReread        \* MUTATION: drop the under-guard re-read (reclaimStaleFileLock)

ASSUME Depth >= 1
\* releaseFileLock retries FILE_LOCK_RELEASE_ATTEMPTS (40) times; the model
\* assumes a transient fault clears within that window (ReleaseFault < 40),
\* so its give-up branch is not modelled.
ASSUME ReleaseFault \in 0..39

Ghost == 0        \* pid of a process that died before the model starts
All == Slots \cup {Ghost}
None == <<>>
Lv == 0..Depth
\* A token is <<pid, incarnation, serial>>; serial makes the nonce unique.
GhostLock == <<Ghost, 0, 1>>
GhostGuard == <<Ghost, 0, 2>>

OwnerPcs == {"cs", "as", "mu"}    \* the process believes it holds the lock
GuardPcs == {"reread", "ren", "restore", "grel", "gunl2"}

VARIABLES
  f,       \* f[k]: content of the level-k file (None = absent)
  grave,   \* records preserved in .stale-* graveyards (evidence only)
  alive, inc,
  live,    \* per slot: the liveTokens set
  pc,
  lv,      \* level of the file this slot is reading/judging/reclaiming
  lt,      \* lock token of the current acquisition
  gt,      \* guard token (for f[lv+1]) of the current withReclaimGuard call
  obs,     \* observed token of f[lv]
  gy,      \* record held in this reclaimer's graveyard
  rc,      \* failed unlink attempts of the current release
  ntok,
  badRename, badGuardReclaim, badRelease, badGuardRelease

vars == <<f, grave, alive, inc, live, pc, lv, lt, gt, obs, gy, rc, ntok,
          badRename, badGuardReclaim, badRelease, badGuardRelease>>
flags == <<badRename, badGuardReclaim, badRelease, badGuardRelease>>

\* The token's writer is alive and may still write it (ground truth).
TrulyLive(t) == alive[t[1]] /\ inc[t[1]] = t[2] /\ t \in live[t[1]]

(* judgeHolder(holder, liveTokens.has(token)) as seen by slot s,           *)
(* processLiveness.ts judgeHolder, same PID domain, well-formed token.    *)
Judge(s, t) ==
  LET o == t[1] IN
  IF o = s THEN t \notin live[s]            \* pid === process.pid
  ELSE IF ~alive[o] THEN TRUE               \* ESRCH
  ELSE IF Linux THEN inc[o] # t[2]          \* starttime differs
  ELSE FALSE                                \* live pid, no birth proof

\* Verdicts slot s may reach. An older build (#4480 item 3) may also
\* lease-break a holder whose birth it cannot prove (a stalled holder).
Verdicts(s, t) == IF s \in OldLease THEN {Judge(s, t), TRUE} ELSE {Judge(s, t)}

Mint(s) == <<s, inc[s], ntok>>

Init ==
  /\ f = [k \in Lv |-> IF k = 0 /\ InitStaleLock THEN GhostLock
                       ELSE IF k = 1 /\ InitStaleGuard THEN GhostGuard
                       ELSE None]
  /\ grave = {}
  /\ alive = [x \in All |-> x # Ghost]
  /\ inc = [x \in All |-> IF x = Ghost THEN 0 ELSE 1]
  /\ live = [x \in All |-> {}]
  /\ pc = [x \in Slots |-> "idle"]
  /\ lv = [x \in Slots |-> 0]
  /\ lt = [x \in Slots |-> None]
  /\ gt = [x \in Slots |-> None]
  /\ obs = [x \in Slots |-> None]
  /\ gy = [x \in Slots |-> None]
  /\ rc = [x \in Slots |-> 0]
  /\ ntok = 3
  /\ badRename = FALSE /\ badGuardReclaim = FALSE
  /\ badRelease = FALSE /\ badGuardRelease = FALSE

Go(s, to) == pc' = [pc EXCEPT ![s] = to]
Retire(s, t) == live' = [live EXCEPT ![s] = @ \ {t}]
Here(s) == lv[s]          \* level being reclaimed
Up(s) == lv[s] + 1        \* level of its guard

\* acquireProcessFileLock: makeOwnershipToken (liveTokens.add) + temp write.
Start(s) ==
  /\ pc[s] = "idle" /\ ntok < MaxTok
  /\ lt' = [lt EXCEPT ![s] = Mint(s)]
  /\ live' = [live EXCEPT ![s] = @ \cup {Mint(s)}]
  /\ ntok' = ntok + 1
  /\ rc' = [rc EXCEPT ![s] = 0]
  /\ Go(s, "link")
  /\ UNCHANGED <<f, grave, alive, inc, lv, gt, obs, gy, flags>>

\* fs.link(temp, lockPath); EEXIST falls through to reclaimStaleFileLock(0).
Link(s) ==
  /\ pc[s] = "link"
  /\ lv' = [lv EXCEPT ![s] = 0]
  /\ IF f[0] = None
       THEN f' = [f EXCEPT ![0] = lt[s]] /\ Go(s, "cs")
       ELSE UNCHANGED f /\ Go(s, "rd")
  /\ UNCHANGED <<grave, alive, inc, live, lt, gt, obs, gy, rc, ntok, flags>>

\* reclaimStaleFileLock: readFile(f[lv]); ENOENT returns to the poll loop.
Read(s) ==
  /\ pc[s] = "rd"
  /\ IF f[Here(s)] = None
       THEN Go(s, "sleep") /\ UNCHANGED obs
       ELSE obs' = [obs EXCEPT ![s] = f[Here(s)]] /\ Go(s, "jd")
  /\ UNCHANGED <<f, grave, alive, inc, live, lv, lt, gt, gy, rc, ntok, flags>>

\* judgeLockToken; live => blocker. Dead at lv = Depth => refuse (fail
\* closed). Dead otherwise => withReclaimGuard mints the guard token + temp.
JudgeLock(s) ==
  /\ pc[s] = "jd"
  /\ \E dead \in Verdicts(s, obs[s]) :
       IF dead /\ Here(s) < Depth
         THEN /\ ntok < MaxTok
              /\ gt' = [gt EXCEPT ![s] = Mint(s)]
              /\ live' = [live EXCEPT ![s] = @ \cup {Mint(s)}]
              /\ ntok' = ntok + 1
              /\ Go(s, "glink")
         ELSE Go(s, "sleep") /\ UNCHANGED <<gt, live, ntok>>
  /\ UNCHANGED <<f, grave, alive, inc, lv, lt, obs, gy, rc, flags>>

\* withReclaimGuard: fs.link(temp, guardPath). EEXIST => reclaim the guard
\* one level up (its token was never published; retiring it now instead of
\* in the finally is unobservable).
GuardLink(s) ==
  /\ pc[s] = "glink"
  /\ IF f[Up(s)] = None
       THEN /\ f' = [f EXCEPT ![Up(s)] = gt[s]]
            /\ rc' = [rc EXCEPT ![s] = 0]
            /\ Go(s, "reread") /\ UNCHANGED <<live, lv>>
       ELSE /\ Retire(s, gt[s])
            /\ lv' = [lv EXCEPT ![s] = @ + 1]
            /\ Go(s, "rd") /\ UNCHANGED <<f, rc>>
  /\ UNCHANGED <<grave, alive, inc, lt, gt, obs, gy, ntok, flags>>

\* Verify-before-displace re-read under the guard (mutation: skipped).
Reread(s) ==
  /\ pc[s] = "reread"
  /\ IF ~NoReread /\ f[Here(s)] # obs[s] THEN Go(s, "grel") ELSE Go(s, "ren")
  /\ UNCHANGED <<f, grave, alive, inc, live, lv, lt, gt, obs, gy, rc, ntok, flags>>

\* rename(f[lv], graveyard) + read of the private graveyard; unlink of the
\* private graveyard when it held `observed`.
Rename(s) ==
  /\ pc[s] = "ren"
  /\ LET k == Here(s) IN
     IF f[k] = None
       THEN Go(s, "grel") /\ UNCHANGED <<f, gy, badRename, badGuardReclaim>>
       ELSE /\ f' = [f EXCEPT ![k] = None]
            /\ badRename' = (badRename \/ (k = 0 /\ TrulyLive(f[k])))
            /\ badGuardReclaim' = (badGuardReclaim \/ (k > 0 /\ TrulyLive(f[k])))
            /\ IF f[k] = obs[s]
                 THEN Go(s, "grel") /\ UNCHANGED gy
                 ELSE gy' = [gy EXCEPT ![s] = f[k]] /\ Go(s, "restore")
  /\ UNCHANGED <<grave, alive, inc, live, lv, lt, gt, obs, rc, ntok,
                 badRelease, badGuardRelease>>

\* link(graveyard, f[lv]); EEXIST => preserve the displaced record.
Restore(s) ==
  /\ pc[s] = "restore"
  /\ IF f[Here(s)] = None
       THEN f' = [f EXCEPT ![Here(s)] = gy[s]] /\ UNCHANGED grave
       ELSE grave' = grave \cup {gy[s]} /\ UNCHANGED f
  /\ gy' = [gy EXCEPT ![s] = None]
  /\ Go(s, "grel")
  /\ UNCHANGED <<alive, inc, live, lv, lt, gt, obs, rc, ntok, flags>>

\* releaseFileLock(guard) read; mismatch or ENOENT => leave it, then the
\* finally's liveTokens.delete.
GuardRelRead(s) ==
  /\ pc[s] = "grel"
  /\ IF f[Up(s)] = gt[s] THEN Go(s, "gunl2") /\ UNCHANGED live
     ELSE Retire(s, gt[s]) /\ Go(s, "sleep")
  /\ UNCHANGED <<f, grave, alive, inc, lv, lt, gt, obs, gy, rc, ntok, flags>>

\* releaseFileLock(guard) unlink; a failure is retried from the read.
GuardRelUnlink(s) ==
  /\ pc[s] = "gunl2"
  /\ \/ /\ f' = [f EXCEPT ![Up(s)] = None]
        /\ badGuardRelease' = (badGuardRelease \/ (f[Up(s)] # None /\ f[Up(s)] # gt[s]))
        /\ Retire(s, gt[s]) /\ Go(s, "sleep")
        /\ UNCHANGED rc
     \/ /\ rc[s] < ReleaseFault
        /\ rc' = [rc EXCEPT ![s] = @ + 1]
        /\ Go(s, "grel")
        /\ UNCHANGED <<f, live, badGuardRelease>>
  /\ UNCHANGED <<grave, alive, inc, lv, lt, gt, obs, gy, ntok,
                 badRename, badGuardReclaim, badRelease>>

\* Poll loop: deadline check + sleep; timeout => finally retires the token.
Sleep(s) ==
  /\ pc[s] = "sleep"
  /\ \/ Go(s, "link") /\ UNCHANGED live
     \/ Retire(s, lt[s]) /\ Go(s, "idle")
  /\ UNCHANGED <<f, grave, alive, inc, lv, lt, gt, obs, gy, rc, ntok, flags>>

\* Critical section: assertStillOwned read, then the irreversible mutation
\* it protects ("mu").
Assert(s) ==
  /\ pc[s] = "cs"
  /\ Go(s, "as")
  /\ UNCHANGED <<f, grave, alive, inc, live, lv, lt, gt, obs, gy, rc, ntok, flags>>
AssertRead(s) ==
  /\ pc[s] = "as"
  /\ IF f[0] = lt[s] THEN Go(s, "mu") ELSE Go(s, "rr")   \* throw => dispose
  /\ UNCHANGED <<f, grave, alive, inc, live, lv, lt, gt, obs, gy, rc, ntok, flags>>
Mutate(s) ==
  /\ pc[s] = "mu"
  /\ Go(s, "cs")
  /\ UNCHANGED <<f, grave, alive, inc, live, lv, lt, gt, obs, gy, rc, ntok, flags>>

\* Dispose -> releaseFileLock read.
Release(s) ==
  /\ pc[s] = "cs"
  /\ rc' = [rc EXCEPT ![s] = 0]
  /\ Go(s, "rr")
  /\ UNCHANGED <<f, grave, alive, inc, live, lv, lt, gt, obs, gy, ntok, flags>>
RelRead(s) ==
  /\ pc[s] = "rr"
  /\ IF f[0] = lt[s] THEN Go(s, "ru") /\ UNCHANGED live
     ELSE Retire(s, lt[s]) /\ Go(s, "idle")     \* mismatch or ENOENT: leave
  /\ UNCHANGED <<f, grave, alive, inc, lv, lt, gt, obs, gy, rc, ntok, flags>>
\* releaseFileLock unlink (a failure is retried from the read), then the
\* dispose's liveTokens.delete.
RelUnlink(s) ==
  /\ pc[s] = "ru"
  /\ \/ /\ f' = [f EXCEPT ![0] = None]
        /\ badRelease' = (badRelease \/ (f[0] # None /\ f[0] # lt[s]))
        /\ Retire(s, lt[s]) /\ Go(s, "idle")
        /\ UNCHANGED rc
     \/ /\ rc[s] < ReleaseFault
        /\ rc' = [rc EXCEPT ![s] = @ + 1]
        /\ Go(s, "rr")
        /\ UNCHANGED <<f, live, badRelease>>
  /\ UNCHANGED <<grave, alive, inc, lv, lt, gt, obs, gy, ntok,
                 badRename, badGuardReclaim, badGuardRelease>>

\* Environment: SIGKILL at any step. Files survive; a held graveyard record
\* stays on disk as a .stale-* file.
Crash(s) ==
  /\ CanCrash /\ alive[s]
  /\ alive' = [alive EXCEPT ![s] = FALSE]
  /\ live' = [live EXCEPT ![s] = {}]
  /\ grave' = IF gy[s] # None THEN grave \cup {gy[s]} ELSE grave
  /\ gy' = [gy EXCEPT ![s] = None]
  /\ Go(s, "dead")
  /\ UNCHANGED <<f, inc, lv, lt, gt, obs, rc, ntok, flags>>

\* Environment: the pid is reused by a new Xum process (new birth).
Restart(s) ==
  /\ ~alive[s] /\ inc[s] < MaxInc
  /\ alive' = [alive EXCEPT ![s] = TRUE]
  /\ inc' = [inc EXCEPT ![s] = @ + 1]
  /\ Go(s, "idle")
  /\ UNCHANGED <<f, grave, live, lv, lt, gt, obs, gy, rc, ntok, flags>>

Step(s) ==
  \/ Start(s) \/ Link(s) \/ Read(s) \/ JudgeLock(s) \/ GuardLink(s)
  \/ Reread(s) \/ Rename(s) \/ Restore(s) \/ GuardRelRead(s)
  \/ GuardRelUnlink(s) \/ Sleep(s) \/ Assert(s) \/ AssertRead(s)
  \/ Mutate(s) \/ Release(s) \/ RelRead(s) \/ RelUnlink(s)

Next == \E s \in Slots : (alive[s] /\ Step(s)) \/ Crash(s) \/ Restart(s)

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* Properties *)

\* Header claim (fileLock.ts module doc): at most one process believes it owns.
MutualExclusion ==
  \A a, b \in Slots : (a # b /\ pc[a] \in OwnerPcs) => pc[b] \notin OwnerPcs

\* Header claim: commit-point assertStillOwned makes displacement harmless,
\* i.e. two processes never pass it concurrently.
CommitExclusion ==
  \A a, b \in Slots : (a # b /\ pc[a] = "mu") => pc[b] # "mu"

\* At most one process believes it holds any one reclaim guard (the
\* serialization every reclaim relies on; the pre-fix stale-guard unlink
\* broke it).
GuardExclusion ==
  \A a, b \in Slots :
    (a # b /\ alive[a] /\ alive[b] /\ pc[a] \in GuardPcs /\ pc[b] \in GuardPcs)
      => lv[a] # lv[b]

\* A live holder is never displaced from the lock.
NoReclaimFromLiveHolder == ~badRename

\* Release never removes another owner's lock or guard.
ReleaseOwnOnly == ~badRelease /\ ~badGuardRelease

\* Reclaiming a guard judged stale never removes a live guard (the pre-fix
\* code's unconditional unlink did).
StaleGuardReclaimSafe == ~badGuardReclaim

\* Wedge proxy: no lock/guard record that nobody owns yet some live process
\* refuses to reclaim. Such a record blocks every other process until its
\* pid exits (judgeHolder never ages out a live pid). Refusal at the depth
\* bound (a dead record at f[Depth]) is a separate, documented residual.
Orphaned(t) ==
  /\ t # None /\ ~TrulyLive(t)
  /\ \E s \in Slots \ OldLease : alive[s] /\ ~Judge(s, t)
NoOrphanLock == ~Orphaned(f[0])
NoOrphanGuard == \A k \in 1..Depth : ~Orphaned(f[k])

TypeOK ==
  /\ pc \in [Slots -> {"idle", "link", "rd", "jd", "glink", "reread", "ren",
                        "restore", "grel", "gunl2", "sleep",
                        "cs", "as", "mu", "rr", "ru", "dead"}]
  /\ lv \in [Slots -> Lv]
  /\ rc \in [Slots -> 0..ReleaseFault]
  /\ ntok <= MaxTok
=============================================================================
