---------------------------- MODULE TaskLaunch ----------------------------
(***************************************************************************)
(* The first launch of ONE sub-agent task T, from its reserved config row  *)
(* to its first turn, at origin/main c5a0b5ad4a:                           *)
(*   src/node/services/taskService.ts                                      *)
(*     startReservedAgentTask (:7566-7971): entry gates (:7573-7664),      *)
(*       materializeReservedTaskWorkspace (:7354-7422: reuse an existing   *)
(*       path :7364, else orchestrateFork in runProjectForkExclusive,      *)
(*       status re-check :7380), post-fork checks (:7704-7727), guarded    *)
(*       path write (:7757), checks (:7778-7801), sanitize (:7809) and     *)
(*       secrets (:7855) awaits, init start (:7863, not awaited), the      *)
(*       abort check (:7898), admission (admitTaskWorkspaceTurn :3932),    *)
(*       the send (:7929), `running` only from owned `starting` (:7961)    *)
(*     cancelReservedLaunch (:7120), cleanupMaterializedTaskWorkspace      *)
(*       (:7163: skips when ownedAttemptSuperseded :7158, retains while a  *)
(*       row exists, deletes only for a missing row), markTaskLaunchFailed *)
(*       (:7460: interrupted, attempt closed, taskPrompt kept)             *)
(*     queue drain CAS queued -> starting with a fresh attempt (:16392)    *)
(*     startup recovery of a stale `starting` row (:5485-5516): queued,    *)
(*       taskPrompt dropped only when history already has it              *)
(*     reactivation of an interrupted task prepends a kept taskPrompt      *)
(*       (:9480-9486)                                                      *)
(*   src/node/services/agentSession.ts  a send whose rows became durable   *)
(*     returns Err when a Stop is in progress (:5629-5649)                 *)
(*   src/node/services/workspaceService.ts  removal aborts the init        *)
(*     (:7454); Stop and launch cancellation do not                        *)
(*                                                                         *)
(* Abstractions: Git and devcontainer steps end in success or failure; a   *)
(* failed fork removes the path it was creating. The sanitize and secrets  *)
(* awaits are one window between the `sanitize` and `init` steps. Backend  *)
(* 1 runs the launch created by the parent's task tool call (its abort     *)
(* signal is Cancel); backend 2 is a second backend on the same root that  *)
(* starts up while backend 1 prepares (U3). Stop is the user's Stop of T:  *)
(* latch + interrupted, then a release that settles (closes) the attempt  *)
(* once no admitted send is in flight. Removal: pendingRemoval mark (init *)
(* aborted), checkout delete, row unpublish. React: the parent reawakens   *)
(* an interrupted T (task_send_message).                                   *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
  AllowCancel, AllowStop, AllowRemove, AllowReact,
  SecondBackend,  \* a second backend starts up on the same root during the launch
  MaxRestarts,    \* crashes + restarts of backend 1
  ForkCanFail,
  Fixes,          \* fixes on; {} = origin/main c5a0b5ad4a, {"initRecheck"} = the shipped code
  Mutant          \* "none" or a mutation that must be caught

B == {1, 2}
MaxA == 4
None == 0

\* U1 (fixed, shipped): recheck cancel, status, attempt and pendingRemoval before the init.
FixInitRecheck == "initRecheck" \in Fixes
\* U2: a missing row (or one a removal marked) is the removal's, not a successor's: delete.
FixMissingRowDeletes == "missingRowDeletes" \in Fixes
\* U4: reawakening prepends a kept taskPrompt only while history lacks it
\* (hasAcceptedInitialTaskPrompt, as startup recovery does).
FixReactSkipsAccepted == "reactSkipsAccepted" \in Fixes
FixPrepLease == "prepLease" \in Fixes             \* U3: preparation holds a use lease
MutRecheckAbortOnly == Mutant = "recheckAbortOnly"
MutClearPromptAlways == Mutant = "clearPromptAlways"
MutCleanupNoOwnerCheck == Mutant = "cleanupNoOwnerCheck"
MutRunningUnguarded == Mutant = "runningUnguarded"
MutFixMissingOnly == Mutant = "fixMissingOnly"  \* the U2 fix without the pendingRemoval case

Pcs == {"idle", "drain", "entry", "forkcheck", "forking", "afterFork", "sanitize", "init",
        "admit", "send", "running", "done"}

VARIABLES
  row,      \* [present, st, aid, prompt (taskPrompt set), pendRm]
  nextAid,
  owned,    \* [B -> attempt this backend owns (0 none)]
  closed,   \* closed (settled) attempts
  latch,    \* T's stop latch
  stopReq,  \* ghost: a Stop of T was requested
  cancel,   \* backend 1's launch abort signal
  lp,       \* [B -> [pc, aid, brief (the plan sends the prompt)]]
  checkout, \* "none" | "partial" | "ready"
  users,    \* launches that hold the checkout (forked or reused it)
  init,     \* [B -> "none" | "running" | "aborted"]
  late,     \* [B -> init started after a cancel or Stop]
  hist,     \* copies of the initial prompt in T's history
  rm,       \* removal: "idle" | "marked" | "deleted" | "done"
  sp,       \* Stop: "idle" | "latched" | "done"
  restarts,
  clobber,     \* ghost: a launch deleted the checkout another backend's live launch holds
  badRunning   \* ghost: `running` written for a row not in this launch's `starting`

vars == <<row, nextAid, owned, closed, latch, stopReq, cancel, lp, checkout, users, init, late,
          hist, rm, sp, restarts, clobber, badRunning>>

Idle == [pc |-> "idle", aid |-> 0, brief |-> FALSE]
Active(b) == lp[b].pc \notin {"idle", "drain", "done"}

Init ==
  /\ row = [present |-> TRUE, st |-> "starting", aid |-> 1, prompt |-> TRUE, pendRm |-> FALSE]
  /\ nextAid = 2
  /\ owned = [b \in B |-> IF b = 1 THEN 1 ELSE 0]
  /\ closed = {}
  /\ latch = FALSE
  /\ stopReq = FALSE
  /\ cancel = FALSE
  /\ lp = [b \in B |-> IF b = 1 THEN [pc |-> "entry", aid |-> 1, brief |-> TRUE] ELSE Idle]
  /\ checkout = "none"
  /\ users = {}
  /\ init = [b \in B |-> "none"]
  /\ late = [b \in B |-> FALSE]
  /\ hist = 0
  /\ rm = "idle"
  /\ sp = "idle"
  /\ restarts = 0
  /\ clobber = FALSE
  /\ badRunning = FALSE

TypeOK ==
  /\ row \in [present : BOOLEAN, st : {"queued", "starting", "running", "interrupted"},
              aid : 0..MaxA, prompt : BOOLEAN, pendRm : BOOLEAN]
  /\ nextAid \in 1..MaxA + 1
  /\ owned \in [B -> 0..MaxA]
  /\ closed \subseteq 0..MaxA
  /\ lp \in [B -> [pc : Pcs, aid : 0..MaxA, brief : BOOLEAN]]
  /\ checkout \in {"none", "partial", "ready"}
  /\ users \subseteq B
  /\ init \in [B -> {"none", "running", "aborted"}]
  /\ late \in [B -> BOOLEAN]
  /\ hist \in 0..3

Cancelled(b) == b = 1 /\ cancel

\* ownedAttemptSuperseded (:7158): an owner whose attempt the row no longer names, which
\* includes a missing row (undefined !== owned). FixMissingRowDeletes: only a present row.
Superseded(b) ==
  /\ owned[b] # None
  /\ IF FixMissingRowDeletes THEN row.present /\ row.aid # owned[b]
                             ELSE ~row.present \/ row.aid # owned[b]

\* Another backend's live launch holds the checkout under the row's current attempt.
SuccessorHolds(b) ==
  \E c \in users : c # b /\ Active(c) /\ row.present /\ row.aid = lp[c].aid

\* cleanupMaterializedTaskWorkspace (:7163): the checkout after b's cleanup.
CleanupCheckout(b) ==
  IF MutCleanupNoOwnerCheck
  THEN IF row.present /\ row.aid = lp[b].aid THEN checkout ELSE "none"
  ELSE IF Superseded(b) THEN checkout
  ELSE IF FixMissingRowDeletes /\ (~row.present \/ (row.pendRm /\ ~MutFixMissingOnly)) THEN "none"
  ELSE IF row.present THEN checkout ELSE "none"
CleanupClobbers(b) == checkout # "none" /\ CleanupCheckout(b) = "none" /\ SuccessorHolds(b)

\* markTaskLaunchFailed (:7460): interrupted + attempt closed unless superseded; the prompt is
\* kept (h: copies history holds then; only the mutant uses it).
FailRow(b, h) ==
  IF row.present /\ ~(owned[b] # None /\ row.aid # owned[b])
  THEN [row EXCEPT !.st = "interrupted",
                   !.prompt = IF MutClearPromptAlways THEN FALSE ELSE row.prompt]
  ELSE row
FailClosed(b) ==
  IF row.present /\ ~(owned[b] # None /\ row.aid # owned[b]) THEN closed \cup {row.aid}
  ELSE closed

Finish(b) ==
  /\ lp' = [lp EXCEPT ![b].pc = "done"]
  /\ users' = users \ {b}

Goto(b, pc) == lp' = [lp EXCEPT ![b].pc = pc]

\* Cleanup, then markTaskLaunchFailed (history then holds h copies); the launch ends.
FailLaunchH(b, h) ==
  /\ checkout' = CleanupCheckout(b)
  /\ clobber' = (clobber \/ CleanupClobbers(b))
  /\ row' = FailRow(b, h)
  /\ closed' = FailClosed(b)
  /\ Finish(b)
FailLaunch(b) == FailLaunchH(b, hist)

\* Cleanup only (row missing); the launch ends.
CleanupOnly(b) ==
  /\ checkout' = CleanupCheckout(b)
  /\ clobber' = (clobber \/ CleanupClobbers(b))
  /\ Finish(b)
  /\ UNCHANGED <<row, closed>>

\* A launch that holds a materialized checkout gives up without failing the row (status no longer
\* `starting`, superseded): it returns and keeps the checkout. FixMissingRowDeletes runs the
\* cleanup on these paths too, so a removal that deleted the checkout earlier is not undone.
Abandon(b) ==
  IF FixMissingRowDeletes THEN CleanupOnly(b)
  ELSE Finish(b) /\ UNCHANGED <<row, closed, checkout, clobber>>

Fixed == <<nextAid, owned, latch, stopReq, cancel, init, late, hist, rm, sp, restarts,
           badRunning>>

-----------------------------------------------------------------------------
(* The launch, one action per await-free segment. *)

Entry(b) ==
  /\ lp[b].pc = "entry"
  /\ IF ~row.present \/ row.st # "starting"
       THEN Finish(b) /\ UNCHANGED <<row, closed, checkout, clobber>>
     ELSE IF latch
       \* deferLaunchWhileStopInProgress (:7582): back to queued under its attempt.
       THEN /\ row' = IF row.aid = lp[b].aid THEN [row EXCEPT !.st = "queued"] ELSE row
            /\ Finish(b) /\ UNCHANGED <<closed, checkout, clobber>>
     ELSE IF row.aid # lp[b].aid
       THEN Finish(b) /\ UNCHANGED <<row, closed, checkout, clobber>>
     ELSE IF Cancelled(b)
       THEN FailLaunch(b)
     ELSE Goto(b, "forkcheck") /\ UNCHANGED <<row, closed, checkout, clobber, users>>
  /\ UNCHANGED Fixed

\* materializeReservedTaskWorkspace: reuse any existing path, else fork (status re-check only).
ForkCheck(b) ==
  /\ lp[b].pc = "forkcheck"
  /\ IF ~row.present \/ row.st # "starting"
       THEN Finish(b) /\ UNCHANGED <<checkout>>
     ELSE IF checkout # "none"
       THEN /\ users' = users \cup {b}
            /\ Goto(b, "afterFork")
            /\ UNCHANGED checkout
       ELSE /\ checkout' = "partial"
            /\ users' = users \cup {b}
            /\ Goto(b, "forking")
  /\ UNCHANGED <<row, closed, clobber>>
  /\ UNCHANGED Fixed

Forked(b) ==
  /\ lp[b].pc = "forking"
  /\ \/ /\ checkout' = "ready"
        /\ Goto(b, "afterFork")
        /\ UNCHANGED <<row, closed, clobber, users>>
     \/ /\ ForkCanFail
        \* The failed fork removes the path it was creating, then markTaskLaunchFailed.
        /\ checkout' = "none"
        /\ clobber' = (clobber \/ SuccessorHolds(b))
        /\ row' = FailRow(b, hist)
        /\ closed' = FailClosed(b)
        /\ Finish(b)
  /\ UNCHANGED Fixed

\* :7704-7801 (the guarded path write and its checks).
AfterFork(b) ==
  /\ lp[b].pc = "afterFork"
  /\ IF Cancelled(b) THEN FailLaunch(b)
     ELSE IF ~row.present THEN CleanupOnly(b)
     ELSE IF row.st # "starting" \/ row.aid # lp[b].aid
       THEN Abandon(b)
     ELSE Goto(b, "sanitize") /\ UNCHANGED <<row, closed, checkout, clobber, users>>
  /\ UNCHANGED Fixed

\* Sanitize (:7809) and secrets (:7855) are awaited between this step and InitStart.
Sanitize(b) ==
  /\ lp[b].pc = "sanitize"
  /\ Goto(b, "init")
  /\ UNCHANGED <<row, closed, checkout, clobber, users>>
  /\ UNCHANGED Fixed

\* runBackgroundInit (:7863): the init hook / devcontainer up starts, not awaited. The U1 recheck
\* runs in the code's order: abort (cancelReservedLaunch), missing row (cleanup), not this
\* launch's `starting` row (return), pendingRemoval (cleanup + throw: markTaskLaunchFailed).
InitStart(b) ==
  /\ lp[b].pc = "init"
  /\ IF FixInitRecheck /\ (Cancelled(b) \/ (~MutRecheckAbortOnly /\
                          (~row.present \/ row.pendRm \/ row.st # "starting"
                           \/ row.aid # lp[b].aid)))
     THEN /\ IF Cancelled(b) THEN FailLaunch(b)
             ELSE IF ~row.present THEN CleanupOnly(b)
             ELSE IF row.st # "starting" \/ row.aid # lp[b].aid THEN Abandon(b)
             ELSE FailLaunch(b)
          /\ UNCHANGED <<init, late>>
     ELSE /\ init' = [init EXCEPT ![b] = "running"]
          \* Late: the launch was cancelled, its task Stopped, or its removal had begun (the
          \* removal aborted only the init running at its mark, :7454).
          /\ late' = [late EXCEPT ![b] = Cancelled(b) \/ stopReq \/ row.pendRm]
          /\ Goto(b, "admit")
          /\ UNCHANGED <<row, closed, checkout, clobber, users>>
  /\ UNCHANGED <<nextAid, owned, latch, stopReq, cancel, hist, rm, sp, restarts, badRunning>>

\* The abort check (:7898) and admitTaskWorkspaceTurn (:3932, no status check).
Admit(b) ==
  /\ lp[b].pc = "admit"
  /\ IF Cancelled(b)
       \/ ~row.present \/ row.pendRm \/ row.aid # lp[b].aid \/ latch \/ row.aid \in closed
     THEN FailLaunch(b)
     ELSE Goto(b, "send") /\ UNCHANGED <<row, closed, checkout, clobber, users>>
  /\ UNCHANGED Fixed

\* sendMessage: accepted (Ok); refused before its rows are durable; or, with a Stop in
\* progress, Err after its rows became durable (agentSession :5629-5649).
Send(b) ==
  /\ lp[b].pc = "send"
  /\ \/ /\ hist' = hist + (IF lp[b].brief THEN 1 ELSE 0)
        /\ Goto(b, "running")
        /\ UNCHANGED <<row, closed, checkout, clobber, users>>
     \/ /\ FailLaunch(b)
        /\ UNCHANGED hist
     \/ /\ latch
        /\ hist' = hist + (IF lp[b].brief THEN 1 ELSE 0)
        /\ FailLaunchH(b, hist')
  /\ UNCHANGED <<nextAid, owned, latch, stopReq, cancel, init, late, rm, sp, restarts,
                 badRunning>>

\* setTaskStatus(running, onlyFromStatus starting, expectedAttemptId) also clears taskPrompt.
Running(b) ==
  /\ lp[b].pc = "running"
  /\ LET ok == row.present /\ row.st = "starting" /\ row.aid = lp[b].aid IN
     /\ row' = IF ok \/ (MutRunningUnguarded /\ row.present)
               THEN [row EXCEPT !.st = "running", !.prompt = FALSE] ELSE row
     /\ badRunning' = (badRunning \/ (MutRunningUnguarded /\ row.present /\ ~ok))
  /\ Finish(b)
  /\ UNCHANGED <<closed, checkout, clobber, nextAid, owned, latch, stopReq, cancel, init, late,
                 hist, rm, sp, restarts>>

\* Queue drain CAS (:16392): queued -> starting under a fresh attempt this backend owns.
Drain(b) ==
  /\ lp[b].pc = "drain"
  /\ row.present /\ row.st = "queued" /\ ~row.pendRm /\ ~latch /\ nextAid <= MaxA
  /\ row' = [row EXCEPT !.st = "starting", !.aid = nextAid]
  /\ owned' = [owned EXCEPT ![b] = nextAid]
  /\ nextAid' = nextAid + 1
  /\ lp' = [lp EXCEPT ![b] = [pc |-> "entry", aid |-> nextAid, brief |-> row.prompt]]
  /\ UNCHANGED <<closed, latch, stopReq, cancel, checkout, users, init, late, hist, rm, sp,
                 restarts, clobber, badRunning>>

-----------------------------------------------------------------------------
(* Environment. *)

Cancel ==
  /\ AllowCancel /\ ~cancel
  /\ cancel' = TRUE
  /\ UNCHANGED <<row, nextAid, owned, closed, latch, stopReq, lp, checkout, users, init, late,
                 hist, rm, sp, restarts, clobber, badRunning>>

StopLatch ==
  /\ AllowStop /\ sp = "idle"
  /\ row.present /\ row.st \in {"queued", "starting", "running"}
  /\ sp' = "latched" /\ latch' = TRUE /\ stopReq' = TRUE
  /\ row' = [row EXCEPT !.st = "interrupted"]
  /\ UNCHANGED <<nextAid, owned, closed, cancel, lp, checkout, users, init, late, hist, rm,
                 restarts, clobber, badRunning>>

\* The release settles the attempt once no admitted send is in flight.
StopRelease ==
  /\ sp = "latched"
  /\ \A b \in B : ~(lp[b].pc \in {"send", "running"} /\ lp[b].aid = row.aid)
  /\ sp' = "done" /\ latch' = FALSE
  /\ closed' = closed \cup {row.aid}
  /\ UNCHANGED <<row, nextAid, owned, stopReq, cancel, lp, checkout, users, init, late, hist,
                 rm, restarts, clobber, badRunning>>

RemoveMark ==
  /\ AllowRemove /\ rm = "idle" /\ row.present
  /\ rm' = "marked"
  /\ row' = [row EXCEPT !.pendRm = TRUE]
  /\ init' = [b \in B |-> IF init[b] = "running" THEN "aborted" ELSE init[b]]
  /\ UNCHANGED <<nextAid, owned, closed, latch, stopReq, cancel, lp, checkout, users, late, hist,
                 sp, restarts, clobber, badRunning>>

RemoveCheckout ==
  /\ rm = "marked"
  /\ rm' = "deleted" /\ checkout' = "none"
  /\ UNCHANGED <<row, nextAid, owned, closed, latch, stopReq, cancel, lp, users, init, late,
                 hist, sp, restarts, clobber, badRunning>>

RemoveRow ==
  /\ rm = "deleted"
  /\ rm' = "done" /\ row' = [row EXCEPT !.present = FALSE]
  /\ UNCHANGED <<nextAid, owned, closed, latch, stopReq, cancel, lp, checkout, users, init, late,
                 hist, sp, restarts, clobber, badRunning>>

\* The parent reawakens an interrupted T: a kept taskPrompt is prepended (:9480-9486).
React ==
  /\ AllowReact
  /\ row.present /\ row.st = "interrupted" /\ ~latch /\ ~row.pendRm
  /\ \A b \in B : ~Active(b)
  /\ hist' = hist + (IF row.prompt /\ ~(FixReactSkipsAccepted /\ hist > 0) THEN 1 ELSE 0)
  /\ row' = [row EXCEPT !.st = "running", !.prompt = FALSE]
  /\ UNCHANGED <<nextAid, owned, closed, latch, stopReq, cancel, lp, checkout, users, init, late,
                 rm, sp, restarts, clobber, badRunning>>

\* Startup recovery (:5485-5516) of a `starting` row: queued, the prompt dropped when history
\* has it. A row whose launch elsewhere holds a use lease is skipped
\* (findTasksInUseByOtherBackends): an admitted send's turn lease; with FixPrepLease the whole
\* preparation holds one.
Recovered(other) ==
  IF row.present /\ row.st = "starting"
     /\ ~(lp[other].pc \in {"send", "running"} \/ (FixPrepLease /\ Active(other)))
  THEN [row EXCEPT !.st = "queued", !.prompt = IF hist > 0 THEN FALSE ELSE row.prompt]
  ELSE row

\* Backend 1 crashes and restarts: its launch, init process, latch and ownership are gone.
Restart ==
  /\ restarts < MaxRestarts
  /\ restarts' = restarts + 1
  /\ row' = Recovered(2)
  /\ owned' = [owned EXCEPT ![1] = None]
  /\ lp' = [lp EXCEPT ![1] = [Idle EXCEPT !.pc = "drain"]]
  /\ users' = users \ {1}
  /\ init' = [init EXCEPT ![1] = "none"]
  /\ late' = [late EXCEPT ![1] = FALSE]
  /\ latch' = FALSE
  /\ sp' = IF sp = "latched" THEN "done" ELSE sp
  /\ UNCHANGED <<nextAid, closed, stopReq, cancel, checkout, hist, rm, clobber, badRunning>>

\* A second backend starts up on the same root while backend 1 prepares (U3).
SecondStart ==
  /\ SecondBackend /\ lp[2].pc = "idle"
  /\ row' = Recovered(1)
  /\ lp' = [lp EXCEPT ![2].pc = "drain"]
  /\ UNCHANGED <<nextAid, owned, closed, latch, stopReq, cancel, checkout, users, init, late,
                 hist, rm, sp, restarts, clobber, badRunning>>

Launch(b) ==
  \/ Entry(b) \/ ForkCheck(b) \/ Forked(b) \/ AfterFork(b) \/ Sanitize(b) \/ InitStart(b)
  \/ Admit(b) \/ Send(b) \/ Running(b) \/ Drain(b)

Next ==
  \/ \E b \in B : Launch(b)
  \/ Cancel \/ StopLatch \/ StopRelease \/ RemoveMark \/ RemoveCheckout \/ RemoveRow \/ React
  \/ Restart \/ SecondStart

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* Invariants. *)

\* A launch waiting for a drain that never comes has touched nothing.
Quiescent ==
  /\ \A b \in B : lp[b].pc \in {"idle", "drain", "done"}
  /\ rm \in {"idle", "done"}
  /\ sp # "latched"

\* A launch cancelled (or Stopped) before its init started leaves no init running.
NoInitAfterCancel == \A b \in B : lp[b].pc = "done" => ~(init[b] = "running" /\ late[b])

\* Once T's row is removed and everything settled, no checkout is left behind.
RemovedRowLeavesNoCheckout == (Quiescent /\ ~row.present) => checkout = "none"

\* A launch never deletes the checkout another backend's live launch holds for the row's attempt.
CleanupNeverTouchesSuccessor == ~clobber

\* Until history has the initial prompt, the row keeps it.
PromptRetainedUntilAccepted == (row.present /\ hist = 0) => row.prompt

\* The initial prompt reaches history at most once.
PromptSentOnce == hist <= 1

\* `running` is written only for the launch's own `starting` row.
RunningOnlyFromOwnedStarting == ~badRunning

\* At most one launch prepares T's checkout at a time (U3).
OneMaterializer == Cardinality(users) <= 1
=============================================================================
