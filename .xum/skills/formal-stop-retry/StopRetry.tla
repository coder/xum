------------------------------- MODULE StopRetry -------------------------------
(***************************************************************************)
(* Property: after a Stop, the stream auto-retry loop never starts that    *)
(* workspace's turn again on its own.                                       *)
(*                                                                         *)
(* One workspace, one AgentSession, one RetryManager. Each action is the   *)
(* code between two awaits that can yield to other work (I/O, an IPC call, *)
(* a timer). SKILL.md maps every action to its function.                   *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
  StopKinds,  \* subset of {"ui", "api", "task"}: the Stops the user may press
  MaxErrors,  \* provider errors the stream may raise
  MaxGen      \* bound on RetryManager.retryGeneration (state constraint)

VARIABLES
  stream,      \* "streaming" | "idle": a provider stream is registered for the turn
  policy,      \* handleStreamError of a failed stream: "none" | "accounting" | "checking" | "settling"
  pCap,        \* the generation handleStreamFailureForAutoRetry captured as isCurrent
  errors,      \* provider errors so far
  enabled,     \* RetryManager.enabled
  gen,         \* RetryManager.retryGeneration
  fiber,       \* RetryManager.retryFiber: "none" | "sleeping" (a backoff is pending)
  fGen,        \* scheduledGeneration of the sleeping fiber
  rpc,         \* the fired retry (retryActiveStream, resumeStream): "idle" | "routing" | "reading" | "deferring"
  rGen,        \* scheduledGeneration the fired retry checks (isCurrent, retrySignal)
  rStopGen,    \* the compactionStopGeneration resumeStream captured
  stopGen,     \* AgentSession.compactionStopGeneration
  latch,       \* TaskStopLatch.workspaceStopsInProgress count (AgentSession.isStopInProgress)
  stop,        \* the Stop the user pressed: "none" or one of StopKinds
  spc,         \* the Stop's progress (see the Stop actions)
  optOut,      \* setAutoRetryEnabled(false) of a ui Stop: "none" | "loading" | "done"
  cancelDebt,  \* a ui/api Stop's compaction cancellation record: blocks automatic recovery
  resumed,          \* ghost: an auto-retry started a turn
  resumedAfterStop  \* ghost: an auto-retry started a turn after the Stop began

vars == <<stream, policy, pCap, errors, enabled, gen, fiber, fGen, rpc, rGen, rStopGen,
          stopGen, latch, stop, spc, optOut, cancelDebt, resumed, resumedAfterStop>>

Kinds == {"ui", "api", "task"}

TypeOK ==
  /\ StopKinds \subseteq Kinds
  /\ stream \in {"streaming", "idle"}
  /\ policy \in {"none", "accounting", "checking", "settling"}
  /\ pCap \in Nat /\ errors \in 0..MaxErrors /\ enabled \in BOOLEAN /\ gen \in Nat
  /\ fiber \in {"none", "sleeping"} /\ fGen \in Nat
  /\ rpc \in {"idle", "routing", "reading", "deferring"} /\ rGen \in Nat /\ rStopGen \in Nat
  /\ stopGen \in Nat /\ latch \in Nat
  /\ stop \in {"none"} \cup Kinds
  /\ spc \in {"none", "stopping", "cleanup", "aborting", "awaitPolicy", "awaitOptOut",
              "awaitSettle", "done"}
  /\ optOut \in {"none", "loading", "done"} /\ cancelDebt \in BOOLEAN
  /\ resumed \in BOOLEAN /\ resumedAfterStop \in BOOLEAN

\* The property.
StopEndsRetries == ~resumedAfterStop

\* Must FAIL (reachability.cfg): an auto-retry can start a turn at all, so a model
\* change that makes retries unreachable cannot pass StopEndsRetries vacuously.
NoRetryEverResumes == ~resumed

\* A sleeping fiber never coexists with a live fired retry (every schedule drops it).
OneRetryAtATime == fiber = "sleeping" => rpc = "idle"

\* AgentSession.isBusy: a stream or its completion policy still owns the turn.
Busy == stream = "streaming" \/ policy # "none"

Init ==
  /\ stream = "streaming" /\ policy = "none" /\ pCap = 0 /\ errors = 0
  /\ enabled = TRUE /\ gen = 0 /\ fiber = "none" /\ fGen = 0
  /\ rpc = "idle" /\ rGen = 0 /\ rStopGen = 0
  /\ stopGen = 0 /\ latch = 0 /\ stop = "none" /\ spc = "none" /\ optOut = "none"
  /\ cancelDebt = FALSE /\ resumed = FALSE /\ resumedAfterStop = FALSE

(* Every retryGeneration bump makes a fired retry stale: from then on its gate *)
(* refuses and its reschedule is a no-op, so it changes nothing. The model     *)
(* drops it (rpc' = "idle") to keep the state space small.                     *)
BumpGen == gen' = gen + 1 /\ rpc' = "idle"

\* RetryManager.handleStreamFailure while enabled: interrupt the old fiber, fork a new one.
Schedule == BumpGen /\ fiber' = "sleeping" /\ fGen' = gen + 1

\* RetryManager.cancel (also abandon and setEnabled(false)).
CancelRetry == BumpGen /\ fiber' = "none" /\ UNCHANGED fGen

\* handleStreamFailureForAutoRetry's checks before retryManager.handleStreamFailure.
MayArm(capturedGen) == ~cancelDebt /\ latch = 0 /\ capturedGen = gen /\ enabled

-----------------------------------------------------------------------------
(* The stream and its error policy (agentSession.ts handleStreamError).      *)

\* The provider fails the stream; the coordinator runs handleStreamError.
StreamErrors ==
  /\ stream = "streaming" /\ errors < MaxErrors
  /\ stream' = "idle" /\ policy' = "accounting" /\ errors' = errors + 1
  /\ UNCHANGED <<pCap, enabled, gen, fiber, fGen, rpc, rGen, rStopGen, stopGen, latch,
                 stop, spc, optOut, cancelDebt, resumed, resumedAfterStop>>

\* restoreGoalAccountingSnapshot and chargeEvaluatorSpendToGoal resolve; the call to
\* handleStreamFailureForAutoRetry captures isCurrent and awaits compactionRecoveryBlocked.
PolicyCaptures ==
  /\ policy = "accounting"
  /\ policy' = "checking" /\ pCap' = gen
  /\ UNCHANGED <<stream, errors, enabled, gen, fiber, fGen, rpc, rGen, rStopGen, stopGen,
                 latch, stop, spc, optOut, cancelDebt, resumed, resumedAfterStop>>

\* compactionRecoveryBlocked and the preference load resolve; MayArm, then
\* retryManager.handleStreamFailure.
PolicySchedules ==
  /\ policy = "checking"
  /\ policy' = "settling"
  /\ IF MayArm(pCap) THEN Schedule ELSE UNCHANGED <<gen, fiber, fGen, rpc>>
  /\ UNCHANGED <<stream, pCap, errors, enabled, rGen, rStopGen, stopGen, latch, stop, spc,
                 optOut, cancelDebt, resumed, resumedAfterStop>>

\* The rest of handleStreamError ends; the operation's settlement resolves.
PolicySettles ==
  /\ policy = "settling"
  /\ policy' = "none"
  /\ UNCHANGED <<stream, pCap, errors, enabled, gen, fiber, fGen, rpc, rGen, rStopGen,
                 stopGen, latch, stop, spc, optOut, cancelDebt, resumed, resumedAfterStop>>

-----------------------------------------------------------------------------
(* The retry (retryManager.ts scheduleRetry; agentSession.ts retryActiveStream *)
(* and resumeStream).                                                          *)

\* The backoff ends: the fiber's guards, onRetry, retryActiveStream's prefix and
\* resumeStream's prefix (retrySignal check, stopGeneration capture) up to its
\* applyAutoRoutedResume await.
RetryFires ==
  /\ fiber = "sleeping"
  /\ fiber' = "none"
  /\ IF fGen = gen /\ enabled
       THEN rpc' = "routing" /\ rGen' = fGen /\ rStopGen' = stopGen
       ELSE UNCHANGED <<rpc, rGen, rStopGen>>
  /\ UNCHANGED <<stream, policy, pCap, errors, enabled, gen, fGen, stopGen, latch, stop, spc,
                 optOut, cancelDebt, resumed, resumedAfterStop>>

\* resumeStream's isBusy check: a busy turn returns started: false, and
\* retryActiveStream reschedules it ("retry_deferred_busy").
RetryRoutes ==
  /\ rpc = "routing"
  /\ rpc' = IF Busy THEN "deferring" ELSE "reading"
  /\ UNCHANGED <<stream, policy, pCap, errors, enabled, gen, fiber, fGen, rGen, rStopGen,
                 stopGen, latch, stop, spc, optOut, cancelDebt, resumed, resumedAfterStop>>

\* The history read, compactionRecoveryBlocked and the pricing gate resolve; the
\* synchronous gate (stopGeneration, retrySignal, isStopInProgress) and
\* coordinator.prepare("resume"). A refused resume goes back to rescheduling.
RetryGate ==
  /\ rpc = "reading"
  /\ IF ~cancelDebt /\ rGen = gen /\ rStopGen = stopGen /\ latch = 0
       THEN /\ stream' = "streaming" /\ rpc' = "idle"
            /\ resumed' = TRUE
            /\ resumedAfterStop' = (resumedAfterStop \/ stop # "none")
       ELSE /\ rpc' = "deferring"
            /\ UNCHANGED <<stream, resumed, resumedAfterStop>>
  /\ UNCHANGED <<policy, pCap, errors, enabled, gen, fiber, fGen, rGen, rStopGen, stopGen,
                 latch, stop, spc, optOut, cancelDebt>>

\* retryActiveStream's handleStreamFailureForAutoRetry(..., isCurrent).
RetryReschedules ==
  /\ rpc = "deferring"
  /\ IF MayArm(rGen) THEN Schedule ELSE rpc' = "idle" /\ UNCHANGED <<gen, fiber, fGen>>
  /\ UNCHANGED <<stream, policy, pCap, errors, enabled, rGen, rStopGen, stopGen, latch, stop,
                 spc, optOut, cancelDebt, resumed, resumedAfterStop>>

-----------------------------------------------------------------------------
(* The Stop. ui and api: workspaceService.ts interruptStream, then          *)
(* agentSession.ts interruptStream. task: taskStopLatch.ts beginWorkspaceStop *)
(* and runWorkspaceStopCleanup (a parent's Stop cascade, task_stop, a failed   *)
(* launch).                                                                    *)

\* The synchronous prefix. ui and api: latchHardInterruptCascade, the start of the ui
\* opt-out (disableAutoRetry), cancelCompaction (stopGeneration + 1, and
\* compactionCancellation.cancel installs the record that blocks automatic recovery
\* until a user send replaces it) and retryManager.abandon("user_interrupt").
\* task: beginWorkspaceStop's latch (Phase A).
StopBegins(k) ==
  /\ stop = "none"
  /\ stop' = k /\ latch' = latch + 1
  /\ IF k \in {"ui", "api"}
       THEN /\ stopGen' = stopGen + 1 /\ cancelDebt' = TRUE
            /\ CancelRetry
            /\ optOut' = IF k = "ui" THEN "loading" ELSE "none"
            /\ spc' = "stopping"
       ELSE /\ spc' = "cleanup"
            /\ UNCHANGED <<stopGen, cancelDebt, gen, fiber, fGen, rpc, optOut>>
  /\ UNCHANGED <<stream, policy, pCap, errors, enabled, rGen, rStopGen, resumed,
                 resumedAfterStop>>

\* task, Phase B: clearQueue and workspaceService.abandonAutoRetry.
TaskCleanupAbandons ==
  /\ spc = "cleanup"
  /\ spc' = "aborting"
  /\ CancelRetry
  /\ UNCHANGED <<stream, policy, pCap, errors, enabled, rGen, rStopGen, stopGen, latch, stop,
                 optOut, cancelDebt, resumed, resumedAfterStop>>

\* streamManager.stopStream (ui, api) or aiService.stopStream (task) aborts a live stream.
StopAbortsStream ==
  /\ spc \in {"stopping", "aborting"}
  /\ stream' = "idle"
  /\ spc' = IF spc = "stopping" THEN "awaitPolicy" ELSE "awaitSettle"
  /\ UNCHANGED <<policy, pCap, errors, enabled, gen, fiber, fGen, rpc, rGen, rStopGen,
                 stopGen, latch, stop, optOut, cancelDebt, resumed, resumedAfterStop>>

\* ui, api: interruptedPolicy, the settlement of the operation the Stop captured.
StopJoinsPolicy ==
  /\ spc = "awaitPolicy" /\ policy = "none"
  /\ spc' = "awaitOptOut"
  /\ UNCHANGED <<stream, policy, pCap, errors, enabled, gen, fiber, fGen, rpc, rGen, rStopGen,
                 stopGen, latch, stop, optOut, cancelDebt, resumed, resumedAfterStop>>

\* ui, api: the opt-out is joined, then the finally releases the latch.
StopReleases ==
  /\ spc = "awaitOptOut" /\ optOut \in {"none", "done"}
  /\ spc' = "done" /\ latch' = latch - 1
  /\ UNCHANGED <<stream, policy, pCap, errors, enabled, gen, fiber, fGen, rpc, rGen, rStopGen,
                 stopGen, stop, optOut, cancelDebt, resumed, resumedAfterStop>>

\* ui: applyAutoRetryEnabled(false) after its preference load: setEnabled(false), cancel.
OptOutApplies ==
  /\ optOut = "loading"
  /\ optOut' = "done" /\ enabled' = FALSE
  /\ CancelRetry
  /\ UNCHANGED <<stream, policy, pCap, errors, rGen, rStopGen, stopGen, latch, stop, spc,
                 cancelDebt, resumed, resumedAfterStop>>

\* task: the stop record releases once the captured turn settled and the cleanup ended.
TaskStopReleases ==
  /\ spc = "awaitSettle" /\ ~Busy
  /\ spc' = "done" /\ latch' = latch - 1
  /\ UNCHANGED <<stream, policy, pCap, errors, enabled, gen, fiber, fGen, rpc, rGen, rStopGen,
                 stopGen, stop, optOut, cancelDebt, resumed, resumedAfterStop>>

-----------------------------------------------------------------------------

\* Nothing is left to happen: no backoff, no fired retry, no policy, no Stop in progress.
Settled ==
  /\ fiber = "none" /\ rpc = "idle" /\ policy = "none" /\ spc \in {"none", "done"}
  /\ UNCHANGED vars

Next ==
  \/ StreamErrors \/ PolicyCaptures \/ PolicySchedules \/ PolicySettles
  \/ RetryFires \/ RetryRoutes \/ RetryGate \/ RetryReschedules
  \/ \E k \in StopKinds : StopBegins(k)
  \/ TaskCleanupAbandons \/ StopAbortsStream \/ StopJoinsPolicy \/ StopReleases
  \/ OptOutApplies \/ TaskStopReleases
  \/ Settled

Spec == Init /\ [][Next]_vars

Bounded == gen <= MaxGen
=============================================================================
