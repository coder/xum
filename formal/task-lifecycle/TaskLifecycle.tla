--------------------------- MODULE TaskLifecycle ---------------------------
(***************************************************************************)
(* Sub-agent attempt lifecycle of ONE agent task C (child of P, under the  *)
(* root R), at origin/main ea52e87b33.                                      *)
(*                                                                          *)
(* Actors (one process each, every await-free segment one action):          *)
(*  - React:   P's task_send_message reawakening C                          *)
(*             (dispatchTrustedDescendantMessage -> reactivateInactiveAgentTask,*)
(*             taskService.ts 9030-9080, 8631-8830).                        *)
(*  - Manual:  the user's Resume / manual send into C                       *)
(*             (WorkspaceService.sendMessage -> reawakenInterruptedTask,     *)
(*             workspaceService.ts 15303-15320, taskService.ts 16151-16328).*)
(*  - Cascade: the user's hard Stop of R (terminateAllDescendantAgentTasks, *)
(*             taskService.ts 10871-11002) with the stop-record release     *)
(*             (recheckWorkspaceStopRelease 2824-2896).                     *)
(*  - Session: turn admission fence (admitTaskWorkspaceTurn 3704-3781),     *)
(*             provider stream start, stream end + report publication       *)
(*             (publishAgentTaskReport 19139-19340).                        *)
(*  - Env:     removal marker (pendingRemoval), process restart + startup   *)
(*             re-drive of `running` rows (initialize 5115-5300).           *)
(*                                                                          *)
(* Abstractions: one backend; Phase A of a cascade and each mutex section   *)
(* are atomic (every competing writer of these fields needs this.mutex);    *)
(* the execution mirror and WTM registration collapse into `reg`; the       *)
(* report CAS is atomic; a refused send leaves no turn.                     *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    MaxA,          \* attempt ids 1..MaxA (0 = none)
    Depth2,        \* TRUE: the sender P is itself a sub-agent (R > P > C)
    InitStatus,    \* C's persisted status at start: "reported" or "interrupted"
    AllowManual,   \* the user may Resume C
    AllowReact,    \* P may message C
    AllowRemoval,  \* a removal may mark C pendingRemoval (and abort)
    MaxRestarts,
    FixReactEpoch,      \* finding L1 fix: reactivation fences on the stop epoch
    FixInactiveRecheck, \* finding L2 fix: each reawakening rechecks, under the mutex, that no
                        \* other unsettled attempt is live
    FixResumeRestore    \* finding L3 fix: a refused admission restores the row

VARIABLES
    row,       \* persisted config row: [st, aid, pr]
    nextAid,
    owned,     \* ownedAttemptByTaskId[C] attempt id
    closedId,  \* attemptSettlementByTaskId[C] attempt id (closing/settled)
    latch,     \* workspaceStopsInProgress[C]
    stopEpoch, \* workspaceStopEpochs[C]
    rec,       \* workspaceStopRecords[C]
    stream,    \* attempt streaming in C's session (0 none)
    pend,      \* attempts with an admitted send that has not started its stream
    manualAids,\* attempts minted by a manual resume (WorkspaceService restores these on failure)
    reg,       \* WTM live registration / execution mirror for C (attempt id, 0 none)
    locks,     \* holder of C's event lock + task-tree lock: "none" | "react"
    rp,        \* React process: [pc, prev, aid, epoch]
    mp,        \* Manual process: [pc, aid, epoch]
    cp,        \* Cascade process: [pc]
    restarts,
    redrive,   \* attempt id the last restart left `running` (0 none): the startup re-drive's
               \* own send outcome is not modeled, so RunningIsLive exempts this attempt only
    \* ghosts
    treeStopped, userActed, autoAfterStop, closedEver, badStart, reopened, lostReports

vars == <<row, nextAid, owned, closedId, latch, stopEpoch, rec, stream, pend, reg, locks,
          manualAids, rp, mp, cp, restarts, redrive, treeStopped, userActed, autoAfterStop, closedEver,
          badStart, reopened, lostReports>>

A == 0..MaxA
NoRec == [on |-> FALSE, aid |-> 0, cap |-> 0, capPend |-> {}, cleaned |-> FALSE]
Ghosts == <<treeStopped, userActed, autoAfterStop, closedEver, badStart, reopened, lostReports>>
Procs == <<rp, mp, cp>>
\* rep: the resume takes the reported-child path (resumeSettledReportedTask); cl/rel: the
\* settlement entry it saw and whether the reported attempt was already released.
MpIdle == [pc |-> "idle", aid |-> 0, epoch |-> 0, rep |-> FALSE, cl |-> 0, rel |-> FALSE]

Init ==
    /\ row = [st |-> InitStatus, aid |-> 1, pr |-> FALSE]
    /\ nextAid = 2
    /\ owned = 0
    /\ closedId = 1      \* the predecessor attempt is settled (it reported or was stopped)
    /\ latch = 0
    /\ stopEpoch = 0
    /\ rec = NoRec
    /\ stream = 0 /\ pend = {} /\ reg = 0 /\ manualAids = {}
    /\ locks = "none"
    /\ rp = [pc |-> "idle", prev |-> 0, aid |-> 0, epoch |-> 0]
    /\ mp = MpIdle
    /\ cp = [pc |-> "idle"]
    /\ restarts = 0
    /\ redrive = 0
    /\ treeStopped = FALSE /\ userActed = FALSE
    /\ autoAfterStop = {} /\ closedEver = {1}
    /\ badStart = FALSE /\ reopened = FALSE /\ lostReports = 0

Idle == stream = 0 /\ pend = {}
Inactive == row.st \in {"reported", "interrupted"} /\ Idle /\ reg = 0
\* An attempt other than the current row's predecessor is owned and unsettled, or executing.
OtherLive == (owned # 0 /\ closedId # owned) \/ ~Idle \/ reg # 0

\* publishAttemptRotation + beginOwnedTaskAttempt (taskService.ts 3495-3501, 2987-3013).
Publish(a) ==
    /\ closedId' = IF closedId # a THEN 0 ELSE closedId
    /\ owned' = a

\* admitTaskWorkspaceTurn (3704-3781): refusal reason or "ok".
Fence(expected) ==
    IF row.pr THEN "removal"                                          \* 3736
    ELSE IF expected # 0 /\ row.aid # expected THEN "stale"          \* 3754
    ELSE IF latch > 0 THEN "stopping"                                 \* 3763
    ELSE IF closedId = row.aid THEN "settled"                         \* 3766
    ELSE "ok"

-----------------------------------------------------------------------------
(* React: P reawakens C (P holds C's event lock and the task-tree lock throughout) *)

\* 9047-9080: C is inactive (reported/interrupted, not streaming, no live continuation).
ReactCheck ==
    /\ AllowReact /\ rp.pc = "idle" /\ locks = "none"
    /\ Inactive
    \* The sender's stream is alive: before the tree Stop, after a user resume, or (P a
    \* sub-agent) until the cascade's Phase B aborts P's stream.
    /\ (~treeStopped \/ userActed \/ (Depth2 /\ cp.pc = "B"))
    /\ locks' = "react"
    /\ rp' = [rp EXCEPT !.pc = "awaits", !.epoch = stopEpoch]
    /\ UNCHANGED <<row, nextAid, owned, closedId, latch, stopEpoch, rec, stream, pend, reg,
                   manualAids, mp, cp, restarts>> /\ UNCHANGED Ghosts

\* After the execution snapshot (9067), unarchive (8651) and checkout probe (8660) awaits,
\* 8655 refreshes the row and 8722 reads previousAttemptId; the payload append (8701) and the
\* lineage evaluation (8723) are awaited next.
ReactRefresh ==
    /\ rp.pc = "awaits"
    /\ rp' = [rp EXCEPT !.pc = "mutex", !.prev = row.aid]
    /\ UNCHANGED <<row, nextAid, owned, closedId, latch, stopEpoch, rec, stream, pend, reg,
                   locks, manualAids, mp, cp, restarts>> /\ UNCHANGED Ghosts

\* 8732-8796 under this.mutex: own latch check, id CAS, re-read, publish, own.
ReactCommit ==
    /\ rp.pc = "mutex"
    /\ nextAid <= MaxA
    /\ LET a == nextAid
           refuse == latch > 0                                          \* 8733
                     \/ row.aid # rp.prev \/ row.pr                     \* 8744-8750
                     \* fix: the stop epoch moved, or the sender's chain is interrupted
                     \* (interruptedParentWorkspaceIds, cleared by the user's next send)
                     \/ (FixReactEpoch /\ (stopEpoch # rp.epoch \/ (treeStopped /\ ~userActed)))
                     \/ (FixInactiveRecheck /\ ~Inactive)
       IN IF refuse
          THEN /\ rp' = [rp EXCEPT !.pc = "idle"]
               /\ locks' = "none"
               /\ UNCHANGED <<row, nextAid, owned, closedId, autoAfterStop>>
          ELSE /\ row' = [row EXCEPT !.aid = a]       \* status untouched: liveness is the mirror
               /\ nextAid' = a + 1
               /\ Publish(a)
               /\ autoAfterStop' = IF treeStopped /\ ~userActed
                                   THEN autoAfterStop \cup {a} ELSE autoAfterStop
               /\ rp' = [rp EXCEPT !.pc = "wtm", !.aid = a]
               /\ UNCHANGED locks
    /\ UNCHANGED <<latch, stopEpoch, rec, stream, pend, reg, manualAids, mp, cp, restarts,
                   treeStopped, userActed, closedEver, badStart, reopened, lostReports>>

\* 8798 createWorkspaceTurn: reservation (WTM 1883-1934, no stop check), then the correlated
\* send's fence without an expected id (workspaceService.ts 15316).
ReactLaunch ==
    /\ rp.pc = "wtm"
    /\ IF Fence(0) = "ok"
       THEN /\ pend' = pend \cup {row.aid}
            /\ reg' = row.aid
       ELSE UNCHANGED <<pend, reg>>                     \* send refused; the handle settles
    /\ rp' = [rp EXCEPT !.pc = "idle"]
    /\ locks' = "none"
    /\ UNCHANGED <<row, nextAid, owned, closedId, latch, stopEpoch, rec, stream, manualAids,
                   mp, cp, restarts>> /\ UNCHANGED Ghosts

-----------------------------------------------------------------------------
(* Manual: the user's send into an idle C takes the resume rescue (workspaceService.ts
   15296-15310); reawakenInterruptedTask holds neither the event nor the tree lock. *)

\* 16155-16222: latch clear, an `interrupted` row or a reported one whose attempt is settled or
\* released (16179-16187, `rel`: no settlement entry and no owner), previous id and stop epoch
\* captured.
ManualStart ==
    /\ AllowManual /\ mp.pc = "idle"
    /\ latch = 0 /\ Idle
    /\ LET rel == closedId = 0 /\ owned = 0
           reported == row.st = "reported" /\ (closedId = row.aid \/ rel)
       IN /\ (row.st = "interrupted" \/ reported)
          /\ mp' = [pc |-> "mutex", epoch |-> stopEpoch, aid |-> row.aid, rep |-> reported,
                    cl |-> closedId, rel |-> rel]
    /\ userActed' = TRUE
    /\ UNCHANGED <<row, nextAid, owned, closedId, latch, stopEpoch, rec, stream, pend, reg,
                   locks, manualAids, rp, cp, restarts, treeStopped, autoAfterStop,
                   closedEver, badStart, reopened, lostReports>>

\* 16242-16323 under this.mutex: recheck latch + epoch (and, on the reported path, the settlement
\* evidence, 16248-16250), CAS (status unchanged, id unchanged) to a fresh id, re-read, publish,
\* own. The interrupted path sets `running`; the reported path keeps `reported` (16281).
\* mp.aid holds previousAttemptId until here.
ManualCommit ==
    /\ mp.pc = "mutex"
    /\ nextAid <= MaxA
    /\ LET a == nextAid IN
       IF latch > 0 \/ stopEpoch # mp.epoch                                \* 16245-16247
          \/ (mp.rep /\ (closedId # mp.cl \/ (mp.rel /\ owned # 0)))     \* 16248-16250
          \/ row.st # (IF mp.rep THEN "reported" ELSE "interrupted")
          \/ row.pr \/ row.aid # mp.aid                                    \* 16262-16276
          \/ (FixInactiveRecheck /\ OtherLive)
       THEN /\ mp' = [mp EXCEPT !.pc = "idle"]
            /\ UNCHANGED <<row, nextAid, owned, closedId, manualAids>>
       ELSE /\ row' = [row EXCEPT !.st = IF mp.rep THEN @ ELSE "running", !.aid = a]
            /\ nextAid' = a + 1
            /\ Publish(a)
            /\ manualAids' = manualAids \cup {a}
            /\ mp' = [mp EXCEPT !.pc = "admit", !.aid = a]
    /\ UNCHANGED <<latch, stopEpoch, rec, stream, pend, reg, locks, rp, cp, restarts>>
    /\ UNCHANGED Ghosts

\* After emitWorkspaceMetadata (16326): admitTaskTurn(reawakenedAttemptId)
\* (workspaceService.ts 15315-15318). Pre-fix, a refusal returns without
\* restoreInterruptedTaskAfterResumeFailure (only 15416/15455 call it). The fix
\* (restoreTaskAfterRefusedResume) calls it on the refusal, after an await: ManualRestore.
ManualAdmit ==
    /\ mp.pc = "admit"
    /\ IF Fence(mp.aid) = "ok"
       THEN /\ pend' = pend \cup {mp.aid}
            /\ mp' = [mp EXCEPT !.pc = "idle"]
       ELSE /\ UNCHANGED pend
            /\ mp' = [mp EXCEPT !.pc = IF FixResumeRestore THEN "restore" ELSE "idle"]
    /\ UNCHANGED <<row, nextAid, owned, closedId, latch, stopEpoch, rec, stream, reg, locks,
                   manualAids, rp, cp, restarts>> /\ UNCHANGED Ghosts

\* restoreInterruptedTaskAfterResumeFailure(previous, mp.aid) (taskService.ts 16339-16405), a
\* separate step: anything may land between the refusal and this write. Its one config edit
\* reverts only a row still `running` under exactly mp.aid (rowSupersedes), and closes the
\* attempt only while this process still owns it.
ManualRestore ==
    /\ mp.pc = "restore"
    /\ IF row.st = "running" /\ row.aid = mp.aid
       THEN /\ row' = [row EXCEPT !.st = "interrupted"]
            /\ IF owned = mp.aid
               THEN /\ closedId' = mp.aid
                    /\ closedEver' = closedEver \cup {mp.aid}
               ELSE UNCHANGED <<closedId, closedEver>>
       ELSE UNCHANGED <<row, closedId, closedEver>>
    /\ mp' = [mp EXCEPT !.pc = "idle"]
    /\ UNCHANGED <<nextAid, owned, latch, stopEpoch, rec, stream, pend, reg, locks, manualAids,
                   rp, cp, restarts, treeStopped, userActed, autoAfterStop, badStart, reopened,
                   lostReports>>

-----------------------------------------------------------------------------
(* Cascade: the user hard-Stops R *)

\* Phase A under this.mutex (10892-10994): bump + latch C, capture the owner, the active turn and
\* pending admissions (beginWorkspaceStop 2647-2692), persist interrupted (a completed report is
\* preserved, applyInterruptedTaskStatus). When P is R itself, R's interruptStream first waits
\* for R's in-flight tool calls (workspaceService.ts 15925-15945; taskService.ts 10362), so a
\* reawakening R started is over before Phase A. With R > P > C, only P's own Phase B waits for
\* P's tool call; C's record releases independently.
CascadeA ==
    /\ cp.pc = "idle" /\ ~treeStopped
    /\ (~Depth2 => rp.pc = "idle")
    /\ stopEpoch' = stopEpoch + 1
    /\ latch' = latch + 1
    /\ rec' = [on |-> TRUE, aid |-> IF owned # 0 THEN owned ELSE row.aid,
               cap |-> stream, capPend |-> pend, cleaned |-> FALSE]
    /\ row' = [row EXCEPT !.st = IF @ = "running" THEN "interrupted" ELSE @]
    /\ cp' = [pc |-> "B"]
    /\ treeStopped' = TRUE
    /\ userActed' = FALSE
    /\ UNCHANGED <<nextAid, owned, closedId, stream, pend, reg, locks, manualAids, rp, mp,
                   restarts, autoAfterStop, closedEver, badStart, reopened, lostReports>>

\* Phase B (runWorkspaceStopCleanup, concurrent per id): clear the queue, abort the captured
\* stream, interrupt the captured execution.
CascadeB ==
    /\ cp.pc = "B"
    /\ stream' = IF stream # 0 /\ stream = rec.cap THEN 0 ELSE stream
    /\ pend' = {}
    /\ reg' = IF reg # 0 /\ (reg = rec.cap \/ reg \in rec.capPend \/ reg = rec.aid) THEN 0 ELSE reg
    /\ rec' = [rec EXCEPT !.cleaned = TRUE]
    /\ cp' = [pc |-> "release"]
    /\ UNCHANGED <<row, nextAid, owned, closedId, latch, stopEpoch, locks, manualAids, rp, mp,
                   restarts>> /\ UNCHANGED Ghosts

\* recheckWorkspaceStopRelease (2824-2896): cleanup done, persisted, captured turn and
\* admissions gone -> drop the latch and settle the captured attempt.
CascadeRelease ==
    /\ cp.pc = "release"
    /\ rec.on /\ rec.cleaned
    /\ (rec.cap = 0 \/ stream # rec.cap)
    /\ latch' = latch - 1
    /\ closedId' = rec.aid
    /\ closedEver' = closedEver \cup {rec.aid}
    /\ rec' = NoRec
    /\ cp' = [pc |-> "done"]
    /\ UNCHANGED <<row, nextAid, owned, stopEpoch, stream, pend, reg, locks, manualAids, rp, mp,
                   restarts, treeStopped, userActed, autoAfterStop, badStart, reopened,
                   lostReports>>

-----------------------------------------------------------------------------
(* Session *)

\* An admitted send claims the turn and the provider stream starts; every later session gate
\* re-runs the token's staleness (attempt id, latch, closure, removal). A refused manual resume
\* is restored by WorkspaceService (15416/15455 -> restoreInterruptedTaskAfterResumeFailure).
StartStream(a) ==
    /\ a \in pend /\ stream = 0
    /\ pend' = pend \ {a}
    /\ IF row.aid = a /\ latch = 0 /\ closedId # a /\ ~row.pr
       THEN /\ stream' = a
            /\ badStart' = (badStart \/ a \in autoAfterStop)
            /\ reopened' = (reopened \/ a \in closedEver)
            /\ UNCHANGED <<row, closedId, closedEver, reg>>
       ELSE /\ UNCHANGED <<stream, badStart, reopened>>
            /\ reg' = IF reg = a THEN 0 ELSE reg
            /\ IF a \in manualAids /\ row.st = "running" /\ row.aid = a
               THEN /\ row' = [row EXCEPT !.st = "interrupted"]
                    /\ closedId' = a
                    /\ closedEver' = closedEver \cup {a}
               ELSE UNCHANGED <<row, closedId, closedEver>>
    /\ UNCHANGED <<nextAid, owned, latch, stopEpoch, rec, locks, manualAids, rp, mp, cp,
                   restarts, treeStopped, userActed, autoAfterStop, lostReports>>

\* Natural stream end with a report: publishAgentTaskReport CASes `reported` on the attempt
\* captured at the stream-end event (19168-19192); a superseded report is dropped.
StreamEnd ==
    /\ stream # 0
    /\ LET a == stream IN
       /\ IF row.aid = a
          THEN /\ row' = [row EXCEPT !.st = "reported"]
               /\ owned' = IF owned = a THEN 0 ELSE owned            \* releaseReportedTaskAttempt
               /\ closedId' = a
               /\ closedEver' = closedEver \cup {a}
               /\ UNCHANGED lostReports
          ELSE /\ lostReports' = lostReports + 1
               /\ UNCHANGED <<row, owned, closedId, closedEver>>
       /\ reg' = IF reg = a THEN 0 ELSE reg
    /\ stream' = 0
    /\ UNCHANGED <<nextAid, latch, stopEpoch, rec, pend, locks, manualAids, rp, mp, cp,
                   restarts, treeStopped, userActed, autoAfterStop, badStart, reopened>>

-----------------------------------------------------------------------------
(* Env *)

\* A removal writes C's pendingRemoval marker, and may abort and clear it (#4478).
MarkRemoval ==
    /\ AllowRemoval /\ ~row.pr /\ row' = [row EXCEPT !.pr = TRUE]
    /\ UNCHANGED <<nextAid, owned, closedId, latch, stopEpoch, rec, stream, pend, reg, locks,
                   manualAids, rp, mp, cp, restarts>> /\ UNCHANGED Ghosts
AbortRemoval ==
    /\ row.pr /\ row' = [row EXCEPT !.pr = FALSE]
    /\ UNCHANGED <<nextAid, owned, closedId, latch, stopEpoch, rec, stream, pend, reg, locks,
                   manualAids, rp, mp, cp, restarts>> /\ UNCHANGED Ghosts

\* Process restart: in-memory state and in-flight operations vanish, the row survives.
Restart ==
    /\ restarts < MaxRestarts
    /\ restarts' = restarts + 1
    /\ owned' = 0 /\ closedId' = 0 /\ latch' = 0 /\ rec' = NoRec
    /\ stream' = 0 /\ pend' = {} /\ reg' = 0 /\ locks' = "none" /\ manualAids' = {}
    /\ rp' = [pc |-> "idle", prev |-> 0, aid |-> 0, epoch |-> 0]
    /\ mp' = MpIdle
    /\ cp' = [pc |-> IF cp.pc = "idle" THEN "idle" ELSE "done"]
    /\ redrive' = IF row.st = "running" THEN row.aid ELSE 0
    /\ UNCHANGED <<row, nextAid, stopEpoch>> /\ UNCHANGED Ghosts

\* Startup re-drive of a row a restart left `running` (initialize 5250-5300): an unowned send
\* under the persisted id (a prior process's attempt cannot be proven retired).
StartupRedrive ==
    /\ redrive # 0 /\ redrive = row.aid /\ row.st = "running" /\ Idle
    /\ Fence(0) = "ok"
    /\ pend' = {row.aid}
    /\ UNCHANGED redrive
    /\ UNCHANGED <<row, nextAid, owned, closedId, latch, stopEpoch, rec, stream, reg, locks,
                   manualAids, rp, mp, cp, restarts>> /\ UNCHANGED Ghosts

Next ==
    \/ /\ \/ ReactCheck \/ ReactRefresh \/ ReactCommit \/ ReactLaunch
          \/ ManualStart \/ ManualCommit \/ ManualAdmit \/ ManualRestore
          \/ CascadeA \/ CascadeB \/ CascadeRelease
          \/ \E a \in 1..MaxA : StartStream(a)
          \/ StreamEnd
          \/ MarkRemoval \/ AbortRemoval
       /\ UNCHANGED redrive
    \/ Restart \/ StartupRedrive

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* Properties *)

TypeOK ==
    /\ row.st \in {"reported", "interrupted", "running"} /\ row.aid \in A
    /\ owned \in A /\ closedId \in A /\ stream \in A /\ pend \subseteq 1..MaxA /\ reg \in A
    /\ latch \in 0..1 /\ redrive \in A

\* No attempt the task machinery published after the user stopped the tree (with no user
\* action since) ever starts a provider stream.
NoAutoStartAfterStop == ~badStart

\* A closed (settled/closing) attempt id never streams again.
NoReopen == ~reopened

\* At most one attempt is live: streaming, admitted, or registered.
AtMostOneLive == Cardinality(({stream, reg} \cup pend) \ {0}) <= 1

\* A report is never lost to a newer attempt that superseded its still-running producer.
NoLostReport == lostReports = 0

\* A `running` row has a live attempt once nothing is in flight. The only exemption is the
\* attempt a restart left `running`: what happens when its startup re-drive is refused is not
\* modeled. Every attempt minted after the restart is checked.
Quiescent == rp.pc = "idle" /\ mp.pc = "idle" /\ cp.pc \in {"idle", "done"} /\ pend = {}
RunningIsLive == (Quiescent /\ row.st = "running") => (stream # 0 \/ redrive = row.aid)
=============================================================================
