------------------------- MODULE WorkspaceLifecycle -------------------------
(***************************************************************************)
(* Workspace creation, finalization, rollback and removal in               *)
(* src/node/services/workspaceService.ts (create ~:5950, createMultiProject *)
(* ~:6507, fork ~:12901, remove/removeUnlocked ~:7028-8230) on a git        *)
(* worktree runtime (src/node/worktree/WorktreeManager.ts).                 *)
(*                                                                         *)
(* Each action is one await-free segment of one operation. Names are       *)
(* abstract: a creation asks for branch "fx" (think feature/x), whose      *)
(* sanitized directory is "fxd" (feature-x); a collision retry uses        *)
(* "fx2"/"fxd2". A user branch may pre-exist under "fx" (the creation      *)
(* reuses it; fork does the same for explicit names) or under "fxd" (an    *)
(* unrelated branch that happens to equal the directory name).             *)
(*                                                                         *)
(* Scenario "single": create()/fork() (identical shape here) in project 1, *)
(* optionally a concurrent second creation of the same name, a removal of  *)
(* the first workspace with retries, and a peer that messages any row it   *)
(* can discover. Scenario "multi": one createMultiProject over projects 1  *)
(* and 2.                                                                  *)
(*                                                                         *)
(* Not modelled: crashes/restart, a second backend, init hooks, archive,   *)
(* deferred materialization (no registration lock is taken for it), plan   *)
(* files, sessions, delegated-turn finalizers.                             *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
  Scenario,        \* "single" | "multi"
  Ops,             \* creation operations (= workspace ids), e.g. {1} or {1, 2}
  UserBranches,    \* branches that exist before anything runs, subset of {"fx", "fxd"}
  Faults,          \* enabled failure points, subset of
                   \* {"lock", "register", "sanitize", "p2create", "metaRead", "removeConfig"}
  Consent,         \* "after-setup" | "none" (create()'s defaultUnrelatedConsent)
  RemoveOp,        \* a removal of workspace 1 runs (single scenario)
  MaxRemoveTries,
  Peer,            \* an unrelated peer messages every discoverable row
  Mutant,          \* "none" | "rollbackDropsReusedBranch" | "grantIgnoresMark" (mutation checks)
  Fixes            \* candidate fixes for the *_fixed configs, subset of
                   \* {"lockRollback", "mpKeep", "noFallback", "mpPendingConsent"}

Projects == IF Scenario = "multi" THEN {1, 2} ELSE {1}
Branches == {"fx", "fx2", "fxd"}
Dirs == {"fxd", "fxd2"}
BR == [k \in 1..2 |-> IF k = 1 THEN "fx" ELSE "fx2"]
DR == [k \in 1..2 |-> IF k = 1 THEN "fxd" ELSE "fxd2"]
None == "none"

VARIABLES
  branches,  \* branches[p]: existing local branches of project p
  dirs,      \* dirs[p][d]: creator op of directory d (0 = none)
  bmap,      \* bmap[p][d]: WorktreeManager's persisted branch map (None = no entry)
  created,   \* created[o][p]: the branch op o created in p (None = it reused one / none)
  rows,      \* rows[o]: the config row of workspace o
  pc,        \* pc[o]: creation step
  cand,      \* cand[o]: name candidate (1 = asked name, 2 = collision suffix)
  result,    \* result[o]: "" | "ok" | "err" | "errkept" (rollback refused, row kept)
  mpDone,    \* projects op 1 already created (multi)
  rmpc,      \* removal step
  rmTries,
  lost       \* ghost: a pre-existing user branch was deleted by an operation not owning it

vars == <<branches, dirs, bmap, created, rows, pc, cand, result, mpDone, rmpc, rmTries, lost>>

NoRow == [present |-> FALSE, dir |-> None, branch |-> None, pending |-> FALSE,
          consent |-> FALSE, pendingRemoval |-> FALSE, inUse |-> FALSE, removed |-> FALSE]

Init ==
  /\ branches = [p \in Projects |-> UserBranches]
  /\ dirs = [p \in Projects |-> [d \in Dirs |-> 0]]
  /\ bmap = [p \in Projects |-> [d \in Dirs |-> None]]
  /\ created = [o \in Ops |-> [p \in Projects |-> None]]
  /\ rows = [o \in Ops |-> NoRow]
  /\ pc = [o \in Ops |-> "rtcreate"]
  /\ cand = [o \in Ops |-> 1]
  /\ result = [o \in Ops |-> ""]
  /\ mpDone = {}
  /\ rmpc = IF RemoveOp THEN "wait" ELSE "off"
  /\ rmTries = 0
  /\ lost = FALSE

CheckedOut(p, b) == \E d \in Dirs : dirs[p][d] # 0 /\ bmap[p][d] = b

\* Delete branch b in p for workspace/op o; `own` says whether o may delete it.
DeleteBranch(p, b, own) ==
  IF b \in branches[p] /\ ~CheckedOut(p, b)
    THEN /\ branches' = [branches EXCEPT ![p] = @ \ {b}]
         /\ lost' = (lost \/ (b \in UserBranches /\ ~own))
    ELSE UNCHANGED <<branches, lost>>

\* WorktreeManager.createWorkspace (WorktreeManager.ts:106-215): a taken directory is a name
\* collision (create() retries with a suffix, workspaceService.ts:6187-6218); an existing branch
\* is reused (createdBranch = false); a branch checked out elsewhere fails `worktree add`.
RtCreate(o, p) ==
  LET k == cand[o]
      d == DR[k]
      b == BR[k]
  IN IF dirs[p][d] # 0
       THEN IF k = 1 /\ Scenario = "single"
              THEN /\ cand' = [cand EXCEPT ![o] = 2]
                   /\ UNCHANGED <<branches, dirs, bmap, created, pc, result, mpDone, lost>>
              ELSE /\ pc' = [pc EXCEPT ![o] = "fail"]
                   /\ UNCHANGED <<branches, dirs, bmap, created, cand, result, mpDone, lost>>
     ELSE IF CheckedOut(p, b)
       THEN /\ pc' = [pc EXCEPT ![o] = "fail"]
            /\ UNCHANGED <<branches, dirs, bmap, created, cand, result, mpDone, lost>>
     ELSE /\ dirs' = [dirs EXCEPT ![p][d] = o]
          /\ bmap' = [bmap EXCEPT ![p][d] = b]
          /\ IF b \in branches[p]
               THEN UNCHANGED <<branches, created>>
               ELSE /\ branches' = [branches EXCEPT ![p] = @ \cup {b}]
                    /\ created' = [created EXCEPT ![o][p] = b]
          /\ UNCHANGED <<cand, result, lost>>
          /\ IF Scenario = "multi"
               THEN /\ mpDone' = mpDone \cup {p}
                    /\ pc' = [pc EXCEPT ![o] = IF p = 1 THEN "rtcreate" ELSE "register"]
               ELSE /\ pc' = [pc EXCEPT ![o] = "lock"]
                    /\ UNCHANGED mpDone

\* Remove op o's checkout in p. `keepBranch` as passed to WorktreeManager.deleteWorkspace; the
\* branch it deletes comes from the branch map (WorktreeManager.ts:831-852).
UndoCheckout(o, p, keepBranch) ==
  LET d == DR[cand[o]]
      b == bmap[p][d]
  IN /\ dirs' = [dirs EXCEPT ![p][d] = 0]
     /\ bmap' = [bmap EXCEPT ![p][d] = None]
     /\ IF keepBranch \/ b = None
          THEN UNCHANGED <<branches, lost>>
          ELSE LET own == created[o][p] = b
               IN IF b \in branches[p]
                    THEN /\ branches' = [branches EXCEPT ![p] = @ \ {b}]
                         /\ lost' = (lost \/ (b \in UserBranches /\ ~own))
                    ELSE UNCHANGED <<branches, lost>>

Finish(o, r) ==
  /\ result' = [result EXCEPT ![o] = r]
  /\ pc' = [pc EXCEPT ![o] = "done"]

-----------------------------------------------------------------------------
\* Single scenario: create() / fork().

SingleRtCreate(o) ==
  /\ Scenario = "single" /\ pc[o] = "rtcreate" /\ RtCreate(o, 1)
  /\ UNCHANGED <<rows, rmpc, rmTries>>

\* A runtime collision with no retry left, or `worktree add` failing: nothing was created.
CreateFailed(o) ==
  /\ pc[o] = "fail"
  /\ Finish(o, "err")
  /\ UNCHANGED <<branches, dirs, bmap, created, rows, cand, mpDone, rmpc, rmTries, lost>>

\* workspaceService.ts:6282 acquireRegistrationSanitizeLock (fork: :13563). Its timeout throws
\* into the outer catch (:6481) while rollBackRegistration is still unset: nothing is undone.
LockFails(o) ==
  /\ Scenario = "single" /\ pc[o] = "lock" /\ "lock" \in Faults
  /\ IF "lockRollback" \in Fixes
       THEN UndoCheckout(o, 1, created[o][1] = None)
       ELSE UNCHANGED <<branches, dirs, bmap, lost>>
  /\ Finish(o, "err")
  /\ UNCHANGED <<created, rows, cand, mpDone, rmpc, rmTries>>

LockOk(o) ==
  /\ Scenario = "single" /\ pc[o] = "lock"
  /\ pc' = [pc EXCEPT ![o] = "register"]
  /\ UNCHANGED <<branches, dirs, bmap, created, rows, cand, result, mpDone, rmpc, rmTries, lost>>

\* :6284-6345 the registration write (pending mark unless "none"); a rejected write undoes the
\* checkout, keeping a reused branch (:6334-6335). Mutant: drop that keep.
RegisterFails(o) ==
  /\ Scenario = "single" /\ pc[o] = "register" /\ "register" \in Faults
  /\ UndoCheckout(o, 1, created[o][1] = None /\ Mutant # "rollbackDropsReusedBranch")
  /\ Finish(o, "err")
  /\ UNCHANGED <<created, rows, cand, mpDone, rmpc, rmTries>>

RegisterOk(o) ==
  /\ Scenario = "single" /\ pc[o] = "register"
  /\ rows' = [rows EXCEPT ![o] = [NoRow EXCEPT !.present = TRUE, !.dir = DR[cand[o]],
                                     !.branch = BR[cand[o]],
                                     !.pending = (Consent = "after-setup")]]
  /\ pc' = [pc EXCEPT ![o] = "sanitize"]
  /\ UNCHANGED <<branches, dirs, bmap, created, cand, result, mpDone, rmpc, rmTries, lost>>

\* :6366-6386 failed sanitization: abortCreationUnlessInUse keeps the row while it is in use
\* (or being removed); otherwise it removes the row and the checkout (keeping a reused branch).
SanitizeFails(o) ==
  /\ Scenario = "single" /\ pc[o] = "sanitize" /\ "sanitize" \in Faults
  /\ IF rows[o].inUse \/ rows[o].pendingRemoval
       THEN /\ rows' = [rows EXCEPT ![o].pending = FALSE]      \* finally :6494
            /\ Finish(o, "errkept")
            /\ UNCHANGED <<branches, dirs, bmap, lost>>
       ELSE /\ rows' = [rows EXCEPT ![o] = [NoRow EXCEPT !.removed = TRUE]]
            /\ UndoCheckout(o, 1, created[o][1] = None /\ Mutant # "rollbackDropsReusedBranch")
            /\ Finish(o, "err")
  /\ UNCHANGED <<created, cand, mpDone, rmpc, rmTries>>

\* :6391-6407 publication: grantCreationUnrelatedWorkspaceConsent (:8752-8805) deletes the mark
\* and grants in one write, only while the mark is there and the row is not being removed;
\* the finally (:6489-6497) clears a mark nothing consumed.
Grant(o) ==
  /\ Scenario = "single" /\ pc[o] = "sanitize"
  /\ LET r == rows[o] IN
     rows' = [rows EXCEPT ![o] =
                IF ~r.present THEN r
                ELSE [r EXCEPT !.pending = FALSE,
                               !.consent = r.consent \/
                                 (((r.pending /\ Consent = "after-setup")
                                   \/ Mutant = "grantIgnoresMark") /\ ~r.pendingRemoval)]]
  /\ Finish(o, "ok")
  /\ UNCHANGED <<branches, dirs, bmap, created, cand, mpDone, rmpc, rmTries, lost>>

-----------------------------------------------------------------------------
\* Multi scenario: createMultiProject (op 1 only).

MpRtCreate == Scenario = "multi" /\ pc[1] = "rtcreate" /\ \E p \in Projects \ mpDone :
                (p = 1 \/ 1 \in mpDone) /\ ~(p = 2 /\ "p2create" \in Faults) /\ RtCreate(1, p)
                /\ UNCHANGED <<rows, rmpc, rmTries>>

\* :6765-6782 project 2's createWorkspace fails: rollbackCreatedWorkspaces() runs with
\* forced = false, so keepBranch = forced && !createdBranch is false (:6708) and the reused
\* branch gets `git branch -d` (merged user branches are modelled as merged).
MpP2Fails ==
  /\ Scenario = "multi" /\ pc[1] = "rtcreate" /\ mpDone = {1} /\ "p2create" \in Faults
  /\ UndoCheckout(1, 1, "mpKeep" \in Fixes /\ created[1][1] = None)
  /\ Finish(1, "err")
  /\ UNCHANGED <<created, rows, cand, mpDone, rmpc, rmTries>>

\* :6841-6858 the registration write mints consent in the row itself (no pending mark).
MpRegister ==
  /\ Scenario = "multi" /\ pc[1] = "register"
  /\ rows' = [rows EXCEPT ![1] = [NoRow EXCEPT !.present = TRUE, !.dir = DR[1],
                                     !.branch = BR[1],
                                     !.consent = "mpPendingConsent" \notin Fixes,
                                     !.pending = "mpPendingConsent" \in Fixes]]
  /\ pc' = [pc EXCEPT ![1] = "metaRead"]
  /\ UNCHANGED <<branches, dirs, bmap, created, cand, result, mpDone, rmpc, rmTries, lost>>

\* :6893-6897 the metadata read fails while the rollback is armed: abortCreationUnlessInUse
\* keeps the row (and its consent) when the workspace is already in use.
MpMetaFails ==
  /\ Scenario = "multi" /\ pc[1] = "metaRead" /\ "metaRead" \in Faults
  /\ IF rows[1].inUse
       THEN /\ rows' = [rows EXCEPT ![1].pending = FALSE]
            /\ Finish(1, "errkept")
            /\ UNCHANGED <<branches, dirs, bmap, lost>>
       ELSE /\ rows' = [rows EXCEPT ![1] = [NoRow EXCEPT !.removed = TRUE]]
            /\ dirs' = [p \in Projects |-> [d \in Dirs |-> IF d = DR[1] THEN 0 ELSE dirs[p][d]]]
            /\ bmap' = [p \in Projects |-> [d \in Dirs |-> IF d = DR[1] THEN None ELSE bmap[p][d]]]
            /\ branches' = [p \in Projects |->
                              IF created[1][p] # None THEN branches[p] \ {created[1][p]}
                              ELSE branches[p]]      \* forced rollback keeps reused branches
            /\ Finish(1, "err")
            /\ UNCHANGED lost
  /\ UNCHANGED <<created, cand, mpDone, rmpc, rmTries>>

MpMetaOk ==
  /\ Scenario = "multi" /\ pc[1] = "metaRead"
  /\ rows' = [rows EXCEPT ![1] = [rows[1] EXCEPT !.consent = rows[1].consent \/ rows[1].pending,
                                                   !.pending = FALSE]]
  /\ Finish(1, "ok")
  /\ UNCHANGED <<branches, dirs, bmap, created, cand, mpDone, rmpc, rmTries, lost>>

-----------------------------------------------------------------------------
\* Peer: task_list scope "instance" shows rows with consent (taskService.ts:15145-15165);
\* a message starts work there, which makes abortCreationUnlessInUse keep the row.
PeerMessages(o) ==
  /\ Peer
  /\ rows[o].present /\ rows[o].consent /\ ~rows[o].pendingRemoval /\ ~rows[o].inUse
  /\ rows' = [rows EXCEPT ![o].inUse = TRUE]
  /\ UNCHANGED <<branches, dirs, bmap, created, pc, cand, result, mpDone, rmpc, rmTries, lost>>

-----------------------------------------------------------------------------
\* Removal of workspace 1 (force = true, keepBranch unset as from the UI), with retries.

\* :7136-7200 claimPendingRemoval.
RmClaim ==
  /\ rmpc = "wait" /\ rows[1].present /\ ~rows[1].pendingRemoval /\ rmTries < MaxRemoveTries
  /\ rows' = [rows EXCEPT ![1].pendingRemoval = TRUE]
  /\ rmpc' = "delete"
  /\ rmTries' = rmTries + 1
  /\ UNCHANGED <<branches, dirs, bmap, created, pc, cand, result, mpDone, lost>>

\* :7791-7798 runtime.deleteWorkspace(projectPath, metadata.name, force): WorktreeManager
\* deletes the mapped branch, or, without a map entry, falls back to the workspace (directory)
\* name (WorktreeManager.ts:831-837, :1084), then drops the entry (:852). A missing directory
\* takes the same path (:857-860).
RmDelete ==
  /\ rmpc = "delete"
  /\ LET d == rows[1].dir
         mapped == bmap[1][d]
         b == IF mapped # None THEN mapped ELSE IF "noFallback" \in Fixes THEN None ELSE d
     IN /\ dirs' = [dirs EXCEPT ![1][d] = 0]
        /\ bmap' = [bmap EXCEPT ![1][d] = None]
        /\ IF b \in branches[1] /\ ~(\E e \in Dirs \ {d} : dirs[1][e] # 0 /\ bmap[1][e] = b)
             THEN /\ branches' = [branches EXCEPT ![1] = @ \ {b}]
                  \* Deleting the workspace's own (even reused) branch is by design.
                  /\ lost' = (lost \/ (b \in UserBranches /\ b # rows[1].branch))
             ELSE UNCHANGED <<branches, lost>>
  /\ rmpc' = "config"
  /\ UNCHANGED <<created, rows, pc, cand, result, mpDone, rmTries>>

\* :8083-8110 deregistration; a failure keeps the row and releases the marker (:8179-8198), so
\* the user can retry.
RmConfigFails ==
  /\ rmpc = "config" /\ "removeConfig" \in Faults
  /\ rows' = [rows EXCEPT ![1].pendingRemoval = FALSE]
  /\ rmpc' = "wait"
  /\ UNCHANGED <<branches, dirs, bmap, created, pc, cand, result, mpDone, rmTries, lost>>

RmConfigOk ==
  /\ rmpc = "config"
  /\ rows' = [rows EXCEPT ![1] = [NoRow EXCEPT !.removed = TRUE]]
  /\ rmpc' = "done"
  /\ UNCHANGED <<branches, dirs, bmap, created, pc, cand, result, mpDone, rmTries, lost>>

Done == \A o \in Ops : pc[o] = "done"

Next ==
  \/ \E o \in Ops :
       \/ SingleRtCreate(o) \/ CreateFailed(o) \/ LockFails(o) \/ LockOk(o)
       \/ RegisterFails(o) \/ RegisterOk(o) \/ SanitizeFails(o) \/ Grant(o)
       \/ PeerMessages(o)
  \/ MpRtCreate \/ MpP2Fails \/ MpRegister \/ MpMetaFails \/ MpMetaOk
  \/ RmClaim \/ RmDelete \/ RmConfigFails \/ RmConfigOk
  \/ (Done /\ UNCHANGED vars)

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
TypeOK ==
  /\ pc \in [Ops -> {"rtcreate", "lock", "register", "sanitize", "metaRead", "fail", "done"}]
  /\ result \in [Ops -> {"", "ok", "err", "errkept"}]
  /\ rmpc \in {"off", "wait", "delete", "config", "done"}

\* A creation that returned Err leaves no checkout and no branch it made.
NoOrphanCheckout ==
  \A o \in Ops : result[o] = "err" =>
    /\ \A p \in Projects, d \in Dirs : dirs[p][d] # o
    \* (a later creation may have made a branch of the same name again)
    /\ \A p \in Projects : created[o][p] = None \/ created[o][p] \notin branches[p]
                            \/ \E o2 \in Ops \ {o} : created[o2][p] = created[o][p]

\* Rollback and removal never delete a pre-existing branch the workspace does not own.
UserBranchSafe == ~lost

\* A failed (or kept-on-refusal) creation leaves no consent grant.
FailedNoGrant ==
  \A o \in Ops : result[o] \in {"err", "errkept"} => ~(rows[o].present /\ rows[o].consent)

\* Exactly one finalization: a finished creation leaves no pending mark and never grants
\* consent that was not requested; a successful one gets it when requested, unless a removal
\* claimed the row first (the grant then fails closed, workspaceService.ts:8768).
Finalized ==
  \A o \in Ops : pc[o] = "done" =>
    /\ ~rows[o].pending
    /\ (rows[o].consent /\ Scenario = "single") => Consent = "after-setup"
    /\ (result[o] = "ok" /\ rows[o].present /\ Scenario = "single" /\ Consent = "after-setup"
        /\ ~(o = 1 /\ rmTries > 0)) => rows[o].consent

\* No two live rows share a name in the project.
UniqueNames ==
  \A o1, o2 \in Ops : (o1 # o2 /\ rows[o1].present /\ rows[o2].present) => rows[o1].dir # rows[o2].dir

\* A removed workspace never reappears, and after a completed removal none of its checkout is
\* left to block re-creating its name.
NoReappear ==
  /\ \A o \in Ops : rows[o].removed => ~rows[o].present
  /\ rmpc = "done" => \A d \in Dirs : dirs[1][d] # 1
=============================================================================
