---------------------------- MODULE WorkflowRuns ----------------------------
(***************************************************************************)
(* Durable execution of ONE workflow run with sequential agent steps, at  *)
(* commit ea52e87b33:                                                      *)
(*   src/node/services/workflows/WorkflowRunner.ts   runWithLease (577),   *)
(*       runAgentStep / classifyPriorAttempt (3226),                       *)
(*       consultFailedCheckpoint (3181), reserveAgentTasks (2919),         *)
(*       appendInterruptedForUnresolvedAttempt (3438), result (942)        *)
(*   src/node/services/workflows/WorkflowRunStore.ts lease (1017-1133),    *)
(*       appendStepRecord / settleAgentAttempt (fenced by lease owner)     *)
(*   src/node/services/workflows/WorkflowService.ts  startWorkflow (574),  *)
(*       startWorkflowInBackground (548), resumeCrashedRuns (234),         *)
(*       interruptRunTree (304)                                            *)
(*   src/node/services/taskService.ts  createMany (onTaskReserved before   *)
(*       commitReservations, 6451), commitReservations (6575),             *)
(*       inspectAttemptOutcome / readUnownedSettlementProof (3997),        *)
(*       startup prepass interruptTaskRecoveryForInactiveWorkflowOwner     *)
(*       (4507, 5216)                                                      *)
(*                                                                         *)
(* Actors: runner slots (one WorkflowRunner instance each; RProc names its *)
(* backend process), backend processes that crash and restart, child      *)
(* tasks, and the user (interrupt, resume, checkpoint retry). The Workflows*)
(* tab list (resumeCrashedRuns) is the crash-recovery trigger.             *)
(*                                                                         *)
(* Abstractions: time is reduced to the lease's `fresh` bit (renewals keep *)
(* it fresh; ExpireDead/ExpireStall clear it). A runner id is its slot:    *)
(* real ids are random per WorkflowRunner (WorkflowService.ts:1483), and a *)
(* slot never runs two instances at once. A child's attempt is owned by   *)
(* the process whose TaskService admitted it; ownership dies with the     *)
(* process. Settlement receipts are written only by an owning process.    *)
(* Each action is one await-free segment or one durable write.            *)
(*                                                                         *)
(* Fix flags (all off = the code at ea52e87b33):                           *)
(*   FixRecoverPending  crash recovery also resumes a pending run whose    *)
(*                      lease is absent or stale                           *)
(*   NoRecordMode       a STARTED checkpoint whose child has no task row:  *)
(*     "unresolved" (code: WorkflowPriorAttemptUnresolvedError),           *)
(*     "naive"      (replace it, as the old taskService.ts:6451 comment    *)
(*                   claimed),                                             *)
(*     "tomb"       (replace it after writing a tombstone row that makes   *)
(*                   a late commitReservations of that id fail; the code   *)
(*                   since the W8 fix: classifyPriorAttempt calls          *)
(*                   TaskService.tombstoneUnpublishedReservation, which    *)
(*                   adds the id to the parent row's                       *)
(*                   taskReservationTombstones only while no row exists    *)
(*                   and this process owns no attempt for it, and          *)
(*                   commitReservations refuses a tombstoned id in its     *)
(*                   own config write)                                     *)
(*   FixPrepassReceipt  the startup prepass that interrupts children of an *)
(*                      inactive run also writes a settlement receipt      *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
  TwoBackends,        \* FALSE: one backend runs both runner slots; TRUE: one slot per backend
  NSteps,             \* sequential agent steps in the script
  MaxChildren,        \* child task ids available (model bound)
  MaxCrashes, MaxInterrupts, MaxDeadlines,
  MaxStalls,          \* times a lease may expire while its owner is alive (sleep, blocked loop)
  UserResumesPending, \* someone knows to workflow_resume a pending run
  FixRecoverPending, NoRecordMode, FixPrepassReceipt,
  MutNoLeaseFence     \* mutant: journal writes skip the lease-owner check

None == "none"
\* Two runner slots: in one backend they model two WorkflowRunner instances of one process
\* (e.g. a crash-recovery resume next to a user resume); with TwoBackends, one per backend.
Runners == {"r1", "r2"}
Procs == IF TwoBackends THEN {"p1", "p2"} ELSE {"p1"}
RProc == [r \in Runners |-> IF TwoBackends /\ r = "r2" THEN "p2" ELSE "p1"]
Kids == 1..MaxChildren
Steps == 1..NSteps

ASSUME TwoBackends \in BOOLEAN /\ NSteps >= 1 /\ MaxChildren >= 1
ASSUME NoRecordMode \in {"unresolved", "naive", "tomb"} /\ MaxStalls \in Nat
ASSUME MutNoLeaseFence \in BOOLEAN
\* One child per step plus one replacement per environment event, so running out of child ids
\* means a replacement loop (IdsSuffice), never a legitimate run.
ASSUME MaxChildren >= NSteps + MaxCrashes + MaxInterrupts + MaxDeadlines + MaxStalls

PCs == {"idle", "created", "acquire", "begin", "step", "reserve", "commit", "wait",
        "drain", "unresolved", "unresolvedStatus", "terminate", "failRun", "failDeadline",
        "failStatus", "result", "complete", "release"}
Modes == {"start", "crash", "resume", "retry"}
Statuses == {"none", "pending", "running", "interrupted", "failed", "completed"}
RowStates == {"none", "live", "reported", "ended", "replaced", "tomb"}

VARIABLES
  status,     \* journal status (last status event; "backgrounded" folds into running)
  resultEv,   \* a `type: "result"` event exists
  lastErr,    \* kind of the latest error event: none | deadline | other | unresolved
  rec,        \* steps.jsonl latest-wins record per step key
  row,        \* child task config row
  receipt,    \* settlement receipt for the child's current attempt
  owner,      \* process owning the child's attempt in memory, or None
  cstep,      \* step a child id was reserved for (0 = unused)
  nextC,
  lease,      \* lease.json owner (runner slot) or None
  fresh,      \* lease younger than staleLeaseMs
  up,         \* process alive
  rs,         \* runner slot state
  crashes, interrupts, deadlines, stalls,
  termPending,\* interruptRunTree wrote "interrupted" and has not terminated children yet
  doneEver,   \* ghost: step result was durably recorded at some point
  reexec,     \* ghost: a child was published for a step whose result was recorded
  bounded     \* ghost: the model ran out of child ids

vars == <<status, resultEv, lastErr, rec, row, receipt, owner, cstep, nextC, lease,
          fresh, up, rs, crashes, interrupts, deadlines, stalls, termPending, doneEver, reexec,
          bounded>>

Rec(k, c) == [k |-> k, c |-> c]
IdleRunner == [pc |-> "idle", mode |-> "start", s |-> 1, c |-> 0, prior |-> 0,
               reattached |-> FALSE, aborted |-> FALSE]

TypeOK ==
  /\ status \in Statuses
  /\ resultEv \in BOOLEAN
  /\ lastErr \in {"none", "deadline", "other", "unresolved"}
  /\ rec \in [Steps -> [k : {"none", "started", "completed", "failed"}, c : 0..MaxChildren]]
  /\ row \in [Kids -> RowStates]
  /\ receipt \in [Kids -> BOOLEAN]
  /\ owner \in [Kids -> Procs \cup {None}]
  /\ cstep \in [Kids -> 0..NSteps]
  /\ nextC \in 1..(MaxChildren + 1)
  /\ lease \in Runners \cup {None}
  /\ fresh \in BOOLEAN
  /\ up \in [Procs -> BOOLEAN]
  /\ \A r \in Runners : rs[r].pc \in PCs /\ rs[r].mode \in Modes
                       /\ rs[r].s \in 1..(NSteps + 1) /\ rs[r].c \in 0..MaxChildren
                       /\ rs[r].prior \in 0..MaxChildren
  /\ termPending \in [Procs -> BOOLEAN]
  /\ doneEver \in [Steps -> BOOLEAN]
  /\ reexec \in BOOLEAN /\ bounded \in BOOLEAN

Init ==
  /\ status = "none" /\ resultEv = FALSE /\ lastErr = "none"
  /\ rec = [s \in Steps |-> Rec("none", 0)]
  /\ row = [c \in Kids |-> "none"] /\ receipt = [c \in Kids |-> FALSE]
  /\ owner = [c \in Kids |-> None] /\ cstep = [c \in Kids |-> 0] /\ nextC = 1
  /\ lease = None /\ fresh = FALSE
  /\ up = [p \in Procs |-> TRUE]
  /\ rs = [r \in Runners |-> IdleRunner]
  /\ crashes = 0 /\ interrupts = 0 /\ deadlines = 0 /\ stalls = 0
  /\ termPending = [p \in Procs |-> FALSE]
  /\ doneEver = [s \in Steps |-> FALSE] /\ reexec = FALSE /\ bounded = FALSE

Active(r) == rs[r].pc # "idle"
Alive(r) == up[RProc[r]]
\* Owner-checked journal write: withExpectedLeaseOwner checks the owner id only, never the
\* lease's age (WorkflowRunStore.ts:1107-1133), so a stale owner nobody replaced still writes.
Owns(r) == MutNoLeaseFence \/ lease = r
\* assertCanAppendEvent / assertCanAppendStepRecord: no ordinary writes once the run left running.
RunOpen == status = "running"
SetPC(r, pc) == rs' = [rs EXCEPT ![r].pc = pc]

\* What readAttemptOutcome returns to a runner in process p (inspectAttemptOutcome,
\* taskService.ts:4138-4319). A child its own process stopped settled with a receipt.
Outcome(p, c) ==
  CASE row[c] = "reported" -> "reported"
    [] row[c] = "live" /\ owner[c] = p -> "live"
    [] row[c] = "live" -> "indeterminate"
    [] row[c] = "ended" /\ receipt[c] -> "ended"
    [] row[c] = "ended" -> "indeterminate"          \* prior-process attempt, no receipt
    [] row[c] = "replaced" -> "indeterminate"       \* claim refused
    [] row[c] = "tomb" -> "norecord"
    [] row[c] = "none" /\ owner[c] = p -> "indeterminate"
    [] OTHER -> "norecord"                           \* strict read: no task record

NextStep(r) ==
  IF rs[r].s = NSteps THEN rs' = [rs EXCEPT ![r].pc = "result", ![r].s = NSteps + 1]
  ELSE rs' = [rs EXCEPT ![r].pc = "step", ![r].s = @ + 1, ![r].c = 0, ![r].prior = 0,
                        ![r].reattached = FALSE]

Unchanged_except_runner == UNCHANGED <<status, resultEv, lastErr, rec, row, receipt, owner,
  cstep, nextC, lease, fresh, up, crashes, interrupts, deadlines, stalls, termPending, doneEver,
  reexec, bounded>>

-----------------------------------------------------------------------------
(* Run creation. startWorkflow: createRun (pending), then the runner. The  *)
(* background start appends "running" WITHOUT a lease first               *)
(* (WorkflowService.ts:561), then runInBackground.                         *)

Create(r) ==
  /\ status = "none" /\ Alive(r) /\ ~Active(r)
  /\ status' = "pending"
  /\ rs' = [rs EXCEPT ![r] = [IdleRunner EXCEPT !.pc = "created"]]
  /\ UNCHANGED <<resultEv, lastErr, rec, row, receipt, owner, cstep, nextC, lease, fresh, up,
                 crashes, interrupts, deadlines, stalls, termPending, doneEver, reexec, bounded>>

StartForeground(r) ==
  /\ rs[r].pc = "created" /\ Alive(r)
  /\ SetPC(r, "acquire") /\ Unchanged_except_runner

StartBackground(r) ==
  /\ rs[r].pc = "created" /\ Alive(r) /\ status = "pending"
  /\ status' = "running"
  /\ SetPC(r, "acquire")
  /\ UNCHANGED <<resultEv, lastErr, rec, row, receipt, owner, cstep, nextC, lease, fresh, up,
                 crashes, interrupts, deadlines, stalls, termPending, doneEver, reexec, bounded>>

-----------------------------------------------------------------------------
(* Entry points that start a runner on an existing run.                    *)

\* resumeCrashedRuns -> resumeCrashRecoveredRun: running/backgrounded only (Service:243, 678),
\* and only once the lease is absent or stale (getLeaseRetryDelayMs).
RecoverList(r) ==
  /\ Alive(r) /\ ~Active(r)
  /\ \/ status = "running"
     \/ FixRecoverPending /\ status = "pending"
  /\ lease = None \/ ~fresh
  /\ rs' = [rs EXCEPT ![r] = [IdleRunner EXCEPT !.pc = "acquire", !.mode = "crash"]]
  /\ Unchanged_except_runner

UserResume(r) ==
  /\ Alive(r) /\ ~Active(r)
  /\ \/ status = "interrupted"
     \/ UserResumesPending /\ status = "pending"
  /\ rs' = [rs EXCEPT ![r] = [IdleRunner EXCEPT !.pc = "acquire", !.mode = "resume"]]
  /\ Unchanged_except_runner

\* retry_from_checkpoint: failed with the QuickJS deadline error (workflowRetryEligibility.ts).
UserRetry(r) ==
  /\ Alive(r) /\ ~Active(r)
  /\ status = "failed" /\ lastErr = "deadline"
  /\ rs' = [rs EXCEPT ![r] = [IdleRunner EXCEPT !.pc = "acquire", !.mode = "retry"]]
  /\ Unchanged_except_runner

-----------------------------------------------------------------------------
(* runWithLease.                                                           *)

\* acquireLease (Store:1017): refuses a fresh lease, even its own; otherwise overwrites.
Acquire(r) ==
  /\ rs[r].pc = "acquire" /\ Alive(r)
  /\ IF lease = None \/ ~fresh
       THEN /\ lease' = r /\ fresh' = TRUE /\ SetPC(r, "begin")
       ELSE /\ UNCHANGED <<lease, fresh>> /\ SetPC(r, "idle")   \* WorkflowRunAlreadyActiveError
  /\ UNCHANGED <<status, resultEv, lastErr, rec, row, receipt, owner, cstep, nextC, up,
                 crashes, interrupts, deadlines, stalls, termPending, doneEver, reexec, bounded>>

\* Runner:635-698: read the run, then the fenced "running" status event.
Begin(r) ==
  /\ rs[r].pc = "begin" /\ Alive(r) /\ Owns(r)
  /\ CASE status = "completed" -> SetPC(r, "release") /\ UNCHANGED status
       [] status = "interrupted" /\ rs[r].mode # "resume" -> SetPC(r, "release") /\ UNCHANGED status
       [] status = "failed" /\ rs[r].mode # "retry" -> SetPC(r, "release") /\ UNCHANGED status
       [] OTHER -> status' = "running"
                    /\ rs' = [rs EXCEPT ![r].pc = "step", ![r].s = 1]
  /\ UNCHANGED <<resultEv, lastErr, rec, row, receipt, owner, cstep, nextC, lease, fresh, up,
                 crashes, interrupts, deadlines, stalls, termPending, doneEver, reexec, bounded>>

\* runAgentStep (Runner:1649-1680) for step s. Classification reads are folded into the
\* durable write that follows them.
StepCompleted(r) ==
  /\ rs[r].pc = "step" /\ Alive(r) /\ rec[rs[r].s].k = "completed"
  /\ NextStep(r) /\ Unchanged_except_runner

StepFresh(r) ==
  /\ rs[r].pc = "step" /\ Alive(r) /\ rec[rs[r].s].k = "none"
  /\ rs' = [rs EXCEPT ![r].pc = "reserve", ![r].prior = 0] /\ Unchanged_except_runner

\* A STARTED checkpoint: classifyPriorAttempt.
StepStarted(r) ==
  LET s == rs[r].s
      c == rec[s].c
      o == Outcome(RProc[r], c)
  IN
  /\ rs[r].pc = "step" /\ Alive(r) /\ rec[s].k = "started"
  /\ CASE o = "reported" ->   \* adopt, then settleAgentAttempt (fenced)
            /\ Owns(r) /\ RunOpen
            /\ rec' = [rec EXCEPT ![s] = Rec("completed", c)]
            /\ doneEver' = [doneEver EXCEPT ![s] = TRUE]
            /\ NextStep(r)
            /\ UNCHANGED <<row>>
       [] o = "live" ->
            /\ rs' = [rs EXCEPT ![r].pc = "wait", ![r].c = c, ![r].reattached = TRUE]
            /\ UNCHANGED <<rec, doneEver, row>>
       [] o = "ended" ->      \* recordStartedAttemptFailed (fenced), then replace with a claim
            /\ Owns(r) /\ RunOpen
            /\ rec' = [rec EXCEPT ![s] = Rec("failed", c)]
            /\ rs' = [rs EXCEPT ![r].pc = "reserve", ![r].prior = c]
            /\ UNCHANGED <<doneEver, row>>
       [] o = "norecord" /\ NoRecordMode = "naive" ->
            /\ rs' = [rs EXCEPT ![r].pc = "reserve", ![r].prior = 0]
            /\ UNCHANGED <<rec, doneEver, row>>
       [] o = "norecord" /\ NoRecordMode = "tomb" ->
            \* tombstoneUnpublishedReservation: one config write that re-checks "no row"; the
            \* code also requires the runner's in-memory lease guard (a subset of this action).
            /\ row' = [row EXCEPT ![c] = "tomb"]
            /\ rs' = [rs EXCEPT ![r].pc = "reserve", ![r].prior = 0]
            /\ UNCHANGED <<rec, doneEver>>
       [] OTHER ->            \* WorkflowPriorAttemptUnresolvedError
            /\ SetPC(r, "unresolved")
            /\ UNCHANGED <<rec, doneEver, row>>
  /\ UNCHANGED <<status, resultEv, lastErr, receipt, owner, cstep, nextC, lease, fresh, up,
                 crashes, interrupts, deadlines, stalls, termPending, reexec, bounded>>

\* A FAILED checkpoint: consultFailedCheckpoint (Runner:3181-3219).
StepFailed(r) ==
  LET s == rs[r].s
      c == rec[s].c
      o == IF c = 0 THEN "norecord" ELSE Outcome(RProc[r], c)
  IN
  /\ rs[r].pc = "step" /\ Alive(r) /\ rec[s].k = "failed"
  /\ CASE o \in {"norecord", "reported"} -> rs' = [rs EXCEPT ![r].pc = "reserve", ![r].prior = 0]
       [] o = "ended" -> rs' = [rs EXCEPT ![r].pc = "reserve", ![r].prior = c]
       [] OTHER -> SetPC(r, "unresolved")
  /\ Unchanged_except_runner

\* reserveAgentTasks -> createMany -> onTaskReserved: the fenced "started" checkpoint names the
\* new child before its task row exists (taskService.ts:6451, Runner:3010).
Reserve(r) ==
  LET s == rs[r].s IN
  /\ rs[r].pc = "reserve" /\ Alive(r) /\ Owns(r) /\ RunOpen
  /\ IF nextC > MaxChildren
       THEN /\ bounded' = TRUE /\ SetPC(r, "release")
            /\ UNCHANGED <<rec, owner, cstep, nextC>>
       ELSE /\ rec' = [rec EXCEPT ![s] = Rec("started", nextC)]
            /\ owner' = [owner EXCEPT ![nextC] = RProc[r]]
            /\ cstep' = [cstep EXCEPT ![nextC] = s]
            /\ nextC' = nextC + 1
            /\ rs' = [rs EXCEPT ![r].pc = "commit", ![r].c = nextC]
            /\ UNCHANGED bounded
  /\ UNCHANGED <<status, resultEv, lastErr, row, receipt, lease, fresh, up, crashes,
                 interrupts, deadlines, stalls, termPending, doneEver, reexec>>

\* commitReservations (taskService.ts:6575): one config write. Not lease-fenced; fenced by the
\* runner's abort signal and by the single-use retire claim of the replaced attempt.
Commit(r) ==
  LET c == rs[r].c
      pr == rs[r].prior
  IN
  /\ rs[r].pc = "commit" /\ Alive(r)
  /\ CASE row[c] # "none" \/ (pr # 0 /\ row[pr] # "ended") ->
            \* createMany throws; settleFailedReservations; the runner's step fails unresolved
            /\ SetPC(r, "unresolved") /\ UNCHANGED <<row, receipt, reexec>>
       [] rs[r].aborted ->      \* persisted interrupted, settled by the owning process
            /\ row' = [row EXCEPT ![c] = "ended"] /\ receipt' = [receipt EXCEPT ![c] = TRUE]
            /\ SetPC(r, "drain") /\ UNCHANGED reexec
       [] OTHER ->
            /\ row' = [k \in Kids |-> IF k = c THEN "live"
                                      ELSE IF k = pr THEN "replaced" ELSE row[k]]
            /\ reexec' = (reexec \/ doneEver[cstep[c]])
            /\ rs' = [rs EXCEPT ![r].pc = "wait", ![r].reattached = FALSE]
            /\ UNCHANGED receipt
  /\ UNCHANGED <<status, resultEv, lastErr, rec, owner, cstep, nextC, lease, fresh, up,
                 crashes, interrupts, deadlines, stalls, termPending, doneEver, bounded>>

\* waitForAgentTask, then settleAgentAttempt (fenced; requires the started record for c).
Wait(r) ==
  LET s == rs[r].s
      c == rs[r].c
  IN
  /\ rs[r].pc = "wait" /\ Alive(r)
  /\ CASE rs[r].aborted -> SetPC(r, "drain") /\ UNCHANGED <<rec, doneEver>>
       [] row[c] = "reported" ->
            /\ Owns(r) /\ RunOpen /\ rec[s] = Rec("started", c)
            /\ rec' = [rec EXCEPT ![s] = Rec("completed", c)]
            /\ doneEver' = [doneEver EXCEPT ![s] = TRUE]
            /\ NextStep(r)
       [] row[c] \in {"ended", "replaced"} /\ rs[r].reattached ->
            \* "Task interrupted" for a resumed prior attempt: record failed, replace
            /\ Owns(r) /\ RunOpen
            /\ rec' = [rec EXCEPT ![s] = Rec("failed", c)]
            /\ rs' = [rs EXCEPT ![r].pc = "step"]
            /\ UNCHANGED doneEver
       [] row[c] \in {"ended", "replaced"} -> SetPC(r, "failRun") /\ UNCHANGED <<rec, doneEver>>
       [] OTHER -> FALSE
  /\ UNCHANGED <<status, resultEv, lastErr, row, receipt, owner, cstep, nextC, lease, fresh,
                 up, crashes, interrupts, deadlines, stalls, termPending, reexec, bounded>>

\* The QuickJS deadline ("Execution interrupted") ends the script while a started child is
\* still live (a parallel sibling's handle, folded onto this step): error + failed.
Deadline(r) ==
  /\ rs[r].pc = "wait" /\ Alive(r) /\ ~rs[r].aborted /\ deadlines < MaxDeadlines
  /\ deadlines' = deadlines + 1
  /\ SetPC(r, "failDeadline")
  /\ UNCHANGED <<status, resultEv, lastErr, rec, row, receipt, owner, cstep, nextC, lease,
                 fresh, up, crashes, interrupts, stalls, termPending, doneEver, reexec, bounded>>

\* settleOwnedAttemptsAfterCancellation (Runner:3381): settle what has settled, keep the rest.
Drain(r) ==
  LET s == rs[r].s
      c == rs[r].c
  IN
  /\ rs[r].pc = "drain" /\ Alive(r)
  /\ IF c # 0 /\ Owns(r) /\ s <= NSteps /\ rec[s] = Rec("started", c)
          /\ row[c] \in {"reported", "ended"}
       THEN /\ rec' = [rec EXCEPT ![s] = Rec(IF row[c] = "reported" THEN "completed"
                                             ELSE "failed", c)]
            /\ doneEver' = [doneEver EXCEPT ![s] = (@ \/ row[c] = "reported")]
       ELSE UNCHANGED <<rec, doneEver>>
  /\ SetPC(r, "release")
  /\ UNCHANGED <<status, resultEv, lastErr, row, receipt, owner, cstep, nextC, lease, fresh,
                 up, crashes, interrupts, deadlines, stalls, termPending, reexec, bounded>>

\* appendInterruptedForUnresolvedAttempt: the error event, then "interrupted" (two fenced
\* appends, so a crash can fall between them), then interruptRun terminates the run's
\* children in a later, separate step (Runner:3438-3459).
Unresolved(r) ==
  /\ rs[r].pc = "unresolved" /\ Alive(r) /\ Owns(r) /\ RunOpen
  /\ lastErr' = "unresolved"
  /\ SetPC(r, "unresolvedStatus")
  /\ UNCHANGED <<status, resultEv, rec, row, receipt, owner, cstep, nextC, lease, fresh, up,
                 crashes, interrupts, deadlines, stalls, termPending, doneEver, reexec, bounded>>

UnresolvedStatus(r) ==
  /\ rs[r].pc = "unresolvedStatus" /\ Alive(r) /\ Owns(r) /\ RunOpen
  /\ status' = "interrupted"
  /\ SetPC(r, "terminate")
  /\ UNCHANGED <<resultEv, lastErr, rec, row, receipt, owner, cstep, nextC, lease, fresh, up,
                 crashes, interrupts, deadlines, stalls, termPending, doneEver, reexec, bounded>>

\* terminateAllDescendantAgentTasks in this process: it can stop (and settle, with a receipt)
\* only the attempts this process owns; others keep running.
StopOwnedChildren(p) ==
  /\ row' = [c \in Kids |-> IF row[c] = "live" /\ owner[c] = p THEN "ended" ELSE row[c]]
  /\ receipt' = [c \in Kids |-> IF row[c] = "live" /\ owner[c] = p THEN TRUE ELSE receipt[c]]

Terminate(r) ==
  /\ rs[r].pc = "terminate" /\ Alive(r)
  /\ StopOwnedChildren(RProc[r])
  /\ SetPC(r, "release")
  /\ UNCHANGED <<status, resultEv, lastErr, rec, owner, cstep, nextC, lease, fresh, up,
                 crashes, interrupts, deadlines, stalls, termPending, doneEver, reexec, bounded>>

\* Runner:904-917: the error event and the "failed" status are separate fenced appends.
FailRun(r) ==
  /\ rs[r].pc \in {"failRun", "failDeadline"} /\ Alive(r) /\ Owns(r) /\ RunOpen
  /\ lastErr' = IF rs[r].pc = "failDeadline" THEN "deadline" ELSE "other"
  /\ SetPC(r, "failStatus")
  /\ UNCHANGED <<status, resultEv, rec, row, receipt, owner, cstep, nextC, lease, fresh, up,
                 crashes, interrupts, deadlines, stalls, termPending, doneEver, reexec, bounded>>

FailStatus(r) ==
  /\ rs[r].pc = "failStatus" /\ Alive(r) /\ Owns(r) /\ RunOpen
  /\ status' = "failed"
  /\ SetPC(r, "release")
  /\ UNCHANGED <<resultEv, lastErr, rec, row, receipt, owner, cstep, nextC, lease, fresh, up,
                 crashes, interrupts, deadlines, stalls, termPending, doneEver, reexec, bounded>>

\* Runner:942-955: the result event and the completed status are separate appends.
Result(r) ==
  /\ rs[r].pc = "result" /\ Alive(r) /\ Owns(r) /\ RunOpen
  /\ resultEv' = TRUE /\ SetPC(r, "complete")
  /\ UNCHANGED <<status, lastErr, rec, row, receipt, owner, cstep, nextC, lease, fresh, up,
                 crashes, interrupts, deadlines, stalls, termPending, doneEver, reexec, bounded>>

Complete(r) ==
  /\ rs[r].pc = "complete" /\ Alive(r) /\ Owns(r) /\ RunOpen
  /\ status' = "completed" /\ SetPC(r, "release")
  /\ UNCHANGED <<resultEv, lastErr, rec, row, receipt, owner, cstep, nextC, lease, fresh, up,
                 crashes, interrupts, deadlines, stalls, termPending, doneEver, reexec, bounded>>

\* finally: releaseLease removes lease.json only if the owner matches (Store:1089).
Release(r) ==
  /\ rs[r].pc = "release" /\ Alive(r)
  /\ IF lease = r THEN lease' = None ELSE UNCHANGED lease
  /\ rs' = [rs EXCEPT ![r] = IdleRunner]
  /\ UNCHANGED <<status, resultEv, lastErr, rec, row, receipt, owner, cstep, nextC, fresh, up,
                 crashes, interrupts, deadlines, stalls, termPending, doneEver, reexec, bounded>>

\* A fenced write that finds another owner, or a failed renewal, ends the runner with no
\* further writes; a write the run state refuses (interrupted/terminal) ends it the same way.
\* The commit is neither (it is not fenced by the lease).
Fenced(r) == rs[r].pc \in {"begin", "step", "reserve", "wait", "unresolved",
                           "unresolvedStatus", "failRun", "failDeadline", "failStatus",
                           "result", "complete"}
LeaseLost(r) ==
  /\ Fenced(r) /\ Alive(r) /\ lease # r
  /\ SetPC(r, "release") /\ Unchanged_except_runner
RunStateRefused(r) ==
  /\ Fenced(r) /\ rs[r].pc # "begin" /\ Alive(r) /\ status # "running"
  /\ SetPC(r, IF rs[r].aborted THEN "drain" ELSE "release") /\ Unchanged_except_runner

-----------------------------------------------------------------------------
(* Environment.                                                            *)

\* interruptRunTree (Service:304-348): abort this process's runner, append "interrupted"
\* (not lease-fenced), then terminate children (a later step).
Interrupt(p) ==
  /\ up[p] /\ interrupts < MaxInterrupts /\ status \in {"pending", "running"}
  /\ interrupts' = interrupts + 1
  /\ status' = "interrupted"
  /\ rs' = [r \in Runners |-> IF RProc[r] = p /\ Active(r) THEN [rs[r] EXCEPT !.aborted = TRUE]
                              ELSE rs[r]]
  /\ termPending' = [termPending EXCEPT ![p] = TRUE]
  /\ UNCHANGED <<resultEv, lastErr, rec, row, receipt, owner, cstep, nextC, lease, fresh, up,
                 crashes, deadlines, stalls, doneEver, reexec, bounded>>

InterruptTerminate(p) ==
  /\ up[p] /\ termPending[p]
  /\ StopOwnedChildren(p)
  /\ termPending' = [termPending EXCEPT ![p] = FALSE]
  /\ UNCHANGED <<status, resultEv, lastErr, rec, owner, cstep, nextC, lease, fresh, up, rs,
                 crashes, interrupts, deadlines, stalls, doneEver, reexec, bounded>>

ChildReport(c) ==
  /\ row[c] = "live" /\ owner[c] # None /\ up[owner[c]]
  /\ row' = [row EXCEPT ![c] = "reported"]
  /\ UNCHANGED <<status, resultEv, lastErr, rec, receipt, owner, cstep, nextC, lease, fresh,
                 up, rs, crashes, interrupts, deadlines, stalls, termPending, doneEver, reexec, bounded>>

Crash(p) ==
  /\ up[p] /\ crashes < MaxCrashes
  /\ crashes' = crashes + 1
  /\ up' = [up EXCEPT ![p] = FALSE]
  /\ rs' = [r \in Runners |-> IF RProc[r] = p THEN IdleRunner ELSE rs[r]]
  /\ owner' = [c \in Kids |-> IF owner[c] = p THEN None ELSE owner[c]]
  /\ termPending' = [termPending EXCEPT ![p] = FALSE]
  /\ UNCHANGED <<status, resultEv, lastErr, rec, row, receipt, cstep, nextC, lease, fresh,
                 interrupts, deadlines, stalls, doneEver, reexec, bounded>>

\* recoverInterruptedTasks: a live child left by a dead process is re-driven by this process
\* when its run is active; otherwise the prepass interrupts it (taskService.ts:5216), with no
\* settlement receipt (receipts need an owned attempt, persistOwnedAttemptSettlement 3141).
RunActive == status \in {"pending", "running"}
Restart(p) ==
  /\ ~up[p]
  /\ up' = [up EXCEPT ![p] = TRUE]
  /\ owner' = [c \in Kids |-> IF row[c] = "live" /\ owner[c] = None /\ RunActive THEN p
                              ELSE owner[c]]
  /\ row' = [c \in Kids |-> IF row[c] = "live" /\ owner[c] = None /\ ~RunActive THEN "ended"
                            ELSE row[c]]
  /\ receipt' = [c \in Kids |-> IF row[c] = "live" /\ owner[c] = None /\ ~RunActive
                                THEN FixPrepassReceipt ELSE receipt[c]]
  /\ UNCHANGED <<status, resultEv, lastErr, rec, cstep, nextC, lease, fresh, rs, crashes,
                 interrupts, deadlines, stalls, termPending, doneEver, reexec, bounded>>

\* Time passes past staleLeaseMs without a renewal: the owner is dead, or (AllowStall) alive but
\* not renewing (suspended host, blocked event loop, renewal waiting on the lock).
ExpireDead ==
  /\ lease # None /\ fresh /\ (~up[RProc[lease]] \/ ~Active(lease))
  /\ fresh' = FALSE
  /\ UNCHANGED <<status, resultEv, lastErr, rec, row, receipt, owner, cstep, nextC, lease, up,
                 rs, crashes, interrupts, deadlines, stalls, termPending, doneEver, reexec, bounded>>
ExpireStall ==
  /\ stalls < MaxStalls /\ lease # None /\ fresh /\ up[RProc[lease]] /\ Active(lease)
  /\ fresh' = FALSE /\ stalls' = stalls + 1
  /\ UNCHANGED <<status, resultEv, lastErr, rec, row, receipt, owner, cstep, nextC, lease, up,
                 rs, crashes, interrupts, deadlines, termPending, doneEver, reexec, bounded>>

-----------------------------------------------------------------------------
RunnerStep(r) ==
  \/ StartForeground(r) \/ StartBackground(r) \/ Acquire(r) \/ Begin(r)
  \/ StepCompleted(r) \/ StepFresh(r) \/ StepStarted(r) \/ StepFailed(r)
  \/ Reserve(r) \/ Commit(r) \/ Wait(r) \/ Drain(r) \/ Unresolved(r) \/ UnresolvedStatus(r)
  \/ Terminate(r) \/ FailRun(r) \/ FailStatus(r) \/ Result(r) \/ Complete(r) \/ Release(r)
  \/ LeaseLost(r)
  \/ RunStateRefused(r)

Next ==
  \/ \E r \in Runners : Create(r) \/ RunnerStep(r) \/ RecoverList(r) \/ UserResume(r)
                         \/ UserRetry(r) \/ Deadline(r)
  \/ \E p \in Procs : Interrupt(p) \/ InterruptTerminate(p) \/ Crash(p) \/ Restart(p)
  \/ \E c \in Kids : ChildReport(c)
  \/ ExpireDead \/ ExpireStall

\* Fair: runners, children, restarts, dead-lease expiry, the Workflows tab list, and a user who
\* keeps resuming / retrying. Not fair: crashes, interrupts, deadlines, stalls.
Fairness ==
  /\ \A r \in Runners : WF_vars(Create(r)) /\ WF_vars(RunnerStep(r)) /\ WF_vars(RecoverList(r))
                         /\ WF_vars(UserResume(r)) /\ WF_vars(UserRetry(r))
  /\ \A p \in Procs : WF_vars(Restart(p)) /\ WF_vars(InterruptTerminate(p))
  /\ \A c \in Kids : WF_vars(ChildReport(c))
  /\ SF_vars(ExpireDead)   \* time passes even while resumes keep bouncing off the lease

Spec == Init /\ [][Next]_vars /\ Fairness

-----------------------------------------------------------------------------
(* Properties.                                                             *)

InFlight(c) == \E r \in Runners : Alive(r) /\ rs[r].pc = "commit" /\ rs[r].c = c
LiveChild(c) == row[c] = "live" \/ (row[c] = "none" /\ InFlight(c))

\* No step ever has two children that can still run (across resume, retry, two backends).
SingleLiveChild ==
  \A s \in Steps : Cardinality({c \in Kids : cstep[c] = s /\ LiveChild(c)}) <= 1

\* A step whose result was durably recorded is never executed again.
NoReexec == ~reexec

\* A run reported completed has every step's final result durably recorded.
CompletedSound == status = "completed" => \A s \in Steps : rec[s].k = "completed"
ResultSound == resultEv => \A s \in Steps : rec[s].k = "completed"

\* The model never runs out of child ids. MaxChildren covers every legitimate replacement
\* (see the ASSUME), so a violation is a replacement loop.
IdsSuffice == ~bounded

\* Every run ends completed or failed: a crash never leaves it pending with nothing to resume
\* it, and a run reported interrupted can always be finished by resuming it. Running out of
\* child ids does not count as ending: a behavior that does is a violation.
Terminates == <>(status \in {"completed", "failed"})
=============================================================================
