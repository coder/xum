------------------------------- MODULE StopRetry -------------------------------
(***************************************************************************)
(* Property: after a Stop, the stream auto-retry loop never starts that    *)
(* workspace's turn again on its own.                                       *)
(*                                                                         *)
(* One workspace, one AgentSession, one RetryManager, and one backend       *)
(* restart before, during or after the Stop's lifetime (never inside the   *)
(* Stop). Each action is the code between two awaits that can yield to     *)
(* other work (I/O, an IPC call, a timer). SKILL.md maps every action to   *)
(* its function.                                                           *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
  StopKinds,  \* subset of {"ui", "api", "task", "turn", "timeout"}: the Stops that may happen
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
  stops,       \* AgentSession.autoRetryStops: abandonAutoRetry calls (task, turn, timeout Stops)
  pStops,      \* the admissionAutoRetryStops of the turn whose error policy runs
  sStops,      \* activeStreamContext.admissionAutoRetryStops of the current turn
  stop,        \* the Stop the user pressed: "none" or one of StopKinds
  spc,         \* the Stop's progress (see the Stop actions)
  optOut,      \* setAutoRetryEnabled(false) of a ui Stop: "none" | "loading" | "done"
  cancelDebt,  \* a ui/api Stop's compaction cancellation record: blocks automatic recovery
  resumed,          \* ghost: an auto-retry started a turn
  resumedAfterStop, \* ghost: an auto-retry started a turn after the Stop began
  marker,      \* the startup abandon marker of the stopped tail is on disk (auto-retry preference file)
  boot,        \* "first" | "restarted" | "recovering" | "scheduling" | "recovered": startup recovery
  stCap,       \* the autoRetryStops that runStartupRecovery captured at its start
  sCap         \* the retry generation that scheduleStartupAutoRetryIfNeeded captured

vars == <<stream, policy, pCap, errors, enabled, gen, fiber, fGen, rpc, rGen, rStopGen,
          stopGen, latch, stops, pStops, sStops, stop, spc, optOut, cancelDebt, resumed, resumedAfterStop,
          marker, boot, stCap, sCap>>

\* The variables of the restart, which the actions of one backend lifetime leave unchanged.
restartVars == <<marker, boot, stCap, sCap>>
\* The startup recovery's own variables.
startupVars == <<boot, stCap, sCap>>

Kinds == {"ui", "api", "task", "turn", "timeout"}

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
              "awaitSettle", "turnCleanup", "turnAborting", "turnRecording", "turnReleasing",
              "timeoutStopping", "timeoutFailing", "done"}
  /\ optOut \in {"none", "loading", "done"} /\ cancelDebt \in BOOLEAN
  /\ stops \in Nat /\ pStops \in Nat /\ sStops \in Nat
  /\ resumed \in BOOLEAN /\ resumedAfterStop \in BOOLEAN
  /\ marker \in BOOLEAN
  /\ boot \in {"first", "restarted", "recovering", "scheduling", "recovered"}
  /\ stCap \in Nat /\ sCap \in Nat

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
  /\ stopGen = 0 /\ latch = 0 /\ stops = 0 /\ pStops = 0 /\ sStops = 0 /\ stop = "none" /\ spc = "none" /\ optOut = "none"
  /\ cancelDebt = FALSE /\ resumed = FALSE /\ resumedAfterStop = FALSE
  /\ marker = FALSE /\ boot = "first" /\ stCap = 0 /\ sCap = 0

(* Every retryGeneration bump makes a fired retry stale: from then on its gate *)
(* refuses and its reschedule is a no-op, so it changes nothing. The model     *)
(* drops it (rpc' = "idle") to keep the state space small.                     *)
BumpGen == gen' = gen + 1 /\ rpc' = "idle"

\* RetryManager.handleStreamFailure while enabled: interrupt the old fiber, fork a new one.
Schedule == BumpGen /\ fiber' = "sleeping" /\ fGen' = gen + 1

\* RetryManager.cancel (also abandon and setEnabled(false)).
CancelRetry == BumpGen /\ fiber' = "none" /\ UNCHANGED fGen

\* handleStreamFailureForAutoRetry's checks before retryManager.handleStreamFailure.
\* The code reads the cancellation record (compactionRecoveryBlocked) one await before
\* the other checks, and the model reads it at the last check. The outcome is the same:
\* a Stop that sets cancelDebt between the two reads also bumps gen in the same step, so
\* the code's capturedGen = gen check refuses too. It does not read the latch: an
\* interrupt of a queued workspace turn latches too, and must leave the running turn's
\* retry alone.
MayArm(capturedGen) == ~cancelDebt /\ capturedGen = gen /\ enabled
\* handleStreamError passes its turn's admissionAutoRetryStops: no abandonAutoRetry since
\* the failed turn's stream started.
PolicyMayArm == MayArm(pCap) /\ pStops = stops

-----------------------------------------------------------------------------
(* The stream and its error policy (agentSession.ts handleStreamError).      *)

\* The provider fails the stream; the coordinator runs handleStreamError.
StreamErrors ==
  /\ stream = "streaming" /\ errors < MaxErrors
  /\ stream' = "idle" /\ policy' = "accounting" /\ errors' = errors + 1 /\ pStops' = sStops
  /\ UNCHANGED <<pCap, enabled, gen, fiber, fGen, rpc, rGen, rStopGen, stopGen, latch, stops,
                 sStops, stop, spc, optOut, cancelDebt, resumed, resumedAfterStop>>
  /\ UNCHANGED restartVars

\* restoreGoalAccountingSnapshot and chargeEvaluatorSpendToGoal resolve; the call to
\* handleStreamFailureForAutoRetry captures isCurrent and awaits compactionRecoveryBlocked.
PolicyCaptures ==
  /\ policy = "accounting"
  /\ policy' = "checking" /\ pCap' = gen
  /\ UNCHANGED <<stream, errors, enabled, gen, fiber, fGen, rpc, rGen, rStopGen, stopGen,
                 latch, stop, spc, optOut, cancelDebt, resumed, resumedAfterStop, stops, pStops, sStops>>
  /\ UNCHANGED restartVars

\* compactionRecoveryBlocked and the preference load resolve; MayArm, then
\* retryManager.handleStreamFailure.
PolicySchedules ==
  /\ policy = "checking"
  /\ policy' = "settling"
  /\ IF PolicyMayArm THEN Schedule ELSE UNCHANGED <<gen, fiber, fGen, rpc>>
  /\ UNCHANGED <<stream, pCap, errors, enabled, rGen, rStopGen, stopGen, latch, stop, spc,
                 optOut, cancelDebt, resumed, resumedAfterStop, stops, pStops, sStops>>
  /\ UNCHANGED restartVars

\* The rest of handleStreamError ends; the operation's settlement resolves. Its
\* updateStartupAutoRetryAbandonFromFailure clears the marker for a retryable error,
\* unless a Stop since the failed turn's stream started (autoRetryStops) owns it.
PolicySettles ==
  /\ policy = "settling"
  /\ policy' = "none"
  /\ marker' = IF pStops = stops THEN FALSE ELSE marker
  /\ UNCHANGED <<stream, pCap, errors, enabled, gen, fiber, fGen, rpc, rGen, rStopGen,
                 stopGen, latch, stop, spc, optOut, cancelDebt, resumed, resumedAfterStop, stops, pStops, sStops>>
  /\ UNCHANGED startupVars

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
                 optOut, cancelDebt, resumed, resumedAfterStop, stops, pStops, sStops>>
  /\ UNCHANGED restartVars

\* resumeStream's isBusy check: a busy turn returns started: false, and
\* retryActiveStream reschedules it ("retry_deferred_busy").
RetryRoutes ==
  /\ rpc = "routing"
  /\ rpc' = IF Busy THEN "deferring" ELSE "reading"
  /\ UNCHANGED <<stream, policy, pCap, errors, enabled, gen, fiber, fGen, rGen, rStopGen,
                 stopGen, latch, stop, spc, optOut, cancelDebt, resumed, resumedAfterStop, stops, pStops, sStops>>
  /\ UNCHANGED restartVars

\* The history read, compactionRecoveryBlocked and the pricing gate resolve; the
\* synchronous gate (stopGeneration, retrySignal, isStopInProgress) and
\* coordinator.prepare("resume"). A refused resume goes back to rescheduling.
RetryGate ==
  /\ rpc = "reading"
  /\ IF ~cancelDebt /\ rGen = gen /\ rStopGen = stopGen /\ latch = 0
       THEN /\ stream' = "streaming" /\ rpc' = "idle" /\ sStops' = stops
            /\ resumed' = TRUE
            /\ resumedAfterStop' = (resumedAfterStop \/ stop # "none")
       ELSE /\ rpc' = "deferring"
            /\ UNCHANGED <<stream, resumed, resumedAfterStop, sStops>>
  /\ UNCHANGED <<policy, pCap, errors, enabled, gen, fiber, fGen, rGen, rStopGen, stopGen,
                 latch, stop, spc, optOut, cancelDebt, stops, pStops>>
  /\ UNCHANGED restartVars

\* retryActiveStream's handleStreamFailureForAutoRetry(..., isCurrent). A failed resume
\* first clears the marker while isCurrent holds (updateStartupAutoRetryAbandonFromFailure);
\* the model clears it for a deferred resume too, which can only add violations.
RetryReschedules ==
  /\ rpc = "deferring"
  /\ IF MayArm(rGen) THEN Schedule ELSE rpc' = "idle" /\ UNCHANGED <<gen, fiber, fGen>>
  /\ marker' = IF rGen = gen THEN FALSE ELSE marker
  /\ UNCHANGED <<stream, policy, pCap, errors, enabled, rGen, rStopGen, stopGen, latch, stop,
                 spc, optOut, cancelDebt, resumed, resumedAfterStop, stops, pStops, sStops>>
  /\ UNCHANGED startupVars

-----------------------------------------------------------------------------
(* The Stop. ui and api: workspaceService.ts interruptStream, then          *)
(* agentSession.ts interruptStream. task: taskStopLatch.ts beginWorkspaceStop *)
(* and runWorkspaceStopCleanup. turn: workspaceTurnManager.ts               *)
(* interruptWorkspaceTurn. timeout: taskService.ts failAgentTaskForHardTimeout. *)

\* The synchronous prefix of each Stop.
\* ui, api: latchHardInterruptCascade, the start of the ui opt-out (disableAutoRetry),
\*   cancelCompaction (stopGeneration + 1, and compactionCancellation.cancel installs the
\*   record that blocks automatic recovery until a user send replaces it) and
\*   retryManager.abandon("user_interrupt"), which is not abandonAutoRetry (stops stays).
\* task: beginWorkspaceStop's latch (Phase A).
\* turn: interruptWorkspaceTurn's latch, under the publication lock. A queued handle latches
\*   too but owns no turn and abandons nothing; it is not modeled (MayArm ignores the latch).
\* timeout: failAgentTaskForHardTimeout's clearQueue and abandonAutoRetry.
StopBegins(k) ==
  /\ stop = "none"
  /\ stop' = k
  /\ CASE k \in {"ui", "api"} ->
            /\ latch' = latch + 1
            /\ stopGen' = stopGen + 1 /\ cancelDebt' = TRUE
            /\ CancelRetry
            /\ optOut' = IF k = "ui" THEN "loading" ELSE "none"
            /\ spc' = "stopping"
            /\ UNCHANGED stops
       [] k = "task" ->
            /\ latch' = latch + 1 /\ UNCHANGED stops
            /\ spc' = "cleanup"
            /\ UNCHANGED <<stopGen, cancelDebt, gen, fiber, fGen, rpc, optOut>>
       [] k = "turn" ->
            /\ latch' = latch + 1 /\ UNCHANGED stops
            /\ spc' = "turnCleanup"
            /\ UNCHANGED <<stopGen, cancelDebt, gen, fiber, fGen, rpc, optOut>>
       [] k = "timeout" ->
            /\ CancelRetry
            /\ spc' = "timeoutStopping"
            /\ stops' = stops + 1
            /\ UNCHANGED <<latch, stopGen, cancelDebt, optOut>>
  /\ UNCHANGED <<stream, policy, pCap, errors, enabled, rGen, rStopGen, pStops, sStops, resumed,
                 resumedAfterStop>>
  /\ UNCHANGED restartVars

\* task, Phase B: clearQueue and workspaceService.abandonAutoRetry.
TaskCleanupAbandons ==
  /\ spc = "cleanup"
  /\ spc' = "aborting"
  /\ CancelRetry /\ stops' = stops + 1
  /\ UNCHANGED <<stream, policy, pCap, errors, enabled, rGen, rStopGen, stopGen, latch, stop,
                 optOut, cancelDebt, resumed, resumedAfterStop, pStops, sStops>>
  /\ UNCHANGED restartVars

\* turn: after the publication lock and the execution-state awaits, abandonAutoRetry for a
\* handle that owns the running turn (shouldStopStream), right before its stream stop.
TurnAbandons ==
  /\ spc = "turnCleanup"
  /\ spc' = "turnAborting"
  /\ CancelRetry /\ stops' = stops + 1
  /\ UNCHANGED <<stream, policy, pCap, errors, enabled, rGen, rStopGen, stopGen, latch, stop,
                 optOut, cancelDebt, resumed, resumedAfterStop, pStops, sStops>>
  /\ UNCHANGED restartVars

\* streamManager.stopStream (ui, api) or aiService.stopStream (task, turn, timeout) aborts
\* a live stream.
StopAbortsStream ==
  /\ spc \in {"stopping", "aborting", "turnAborting", "timeoutStopping"}
  /\ stream' = "idle"
  /\ spc' = CASE spc = "stopping" -> "awaitPolicy"
              [] spc = "aborting" -> "awaitSettle"
              [] spc = "turnAborting" -> "turnRecording"
              [] spc = "timeoutStopping" -> "timeoutFailing"
  /\ UNCHANGED <<policy, pCap, errors, enabled, gen, fiber, fGen, rpc, rGen, rStopGen,
                 stopGen, latch, stops, pStops, sStops, stop, optOut, cancelDebt, resumed, resumedAfterStop>>
  /\ UNCHANGED restartVars

\* turn: recordStopForStartupRecovery after the stream stop persists the startup abandon
\* marker of the stopped tail, as a user abort does, then abandons again: a startup recovery
\* that armed a retry since the first abandon (its session was not reached yet) loses it.
TurnRecords ==
  /\ spc = "turnRecording"
  /\ spc' = "turnReleasing" /\ marker' = TRUE
  /\ CancelRetry /\ stops' = stops + 1
  /\ UNCHANGED <<stream, policy, pCap, errors, enabled, rGen, rStopGen, stopGen, latch, pStops,
                 sStops, stop, optOut, cancelDebt, resumed, resumedAfterStop>>
  /\ UNCHANGED startupVars

\* turn: the method-level finally releases the latch after the stream stop and the
\* cleanup. It does not wait for an error policy that is still running.
TurnStopReleases ==
  /\ spc = "turnReleasing"
  /\ spc' = "done" /\ latch' = latch - 1
  /\ UNCHANGED <<stream, policy, pCap, errors, enabled, gen, fiber, fGen, rpc, rGen, rStopGen,
                 stopGen, stops, pStops, sStops, stop, optOut, cancelDebt, resumed, resumedAfterStop>>
  /\ UNCHANGED restartVars

\* timeout: failAgentTaskTerminally. Live work (a turn generation) gets a stop record,
\* which latches and runs the task cleanup; an idle task gets none. The code awaits the
\* TaskService mutex between the sample and beginWorkspaceStop; the model takes both in
\* one step, because the timeout's abandon already bumped gen and stops before it.
TimeoutFails ==
  /\ spc = "timeoutFailing"
  /\ IF Busy
       THEN /\ spc' = "cleanup" /\ latch' = latch + 1
       ELSE /\ spc' = "done" /\ UNCHANGED latch
  /\ UNCHANGED <<stream, policy, pCap, errors, enabled, gen, fiber, fGen, rpc, rGen, rStopGen,
                 stopGen, stops, pStops, sStops, stop, optOut, cancelDebt, resumed,
                 resumedAfterStop>>
  /\ UNCHANGED restartVars

\* ui, api: interruptedPolicy, the settlement of the operation the Stop captured.
StopJoinsPolicy ==
  /\ spc = "awaitPolicy" /\ policy = "none"
  /\ spc' = "awaitOptOut"
  /\ UNCHANGED <<stream, policy, pCap, errors, enabled, gen, fiber, fGen, rpc, rGen, rStopGen,
                 stopGen, latch, stop, optOut, cancelDebt, resumed, resumedAfterStop, stops, pStops, sStops>>
  /\ UNCHANGED restartVars

\* ui, api: the opt-out is joined, then the finally releases the latch.
StopReleases ==
  /\ spc = "awaitOptOut" /\ optOut \in {"none", "done"}
  /\ spc' = "done" /\ latch' = latch - 1
  /\ UNCHANGED <<stream, policy, pCap, errors, enabled, gen, fiber, fGen, rpc, rGen, rStopGen,
                 stopGen, stop, optOut, cancelDebt, resumed, resumedAfterStop, stops, pStops, sStops>>
  /\ UNCHANGED restartVars

\* ui: applyAutoRetryEnabled(false) after its preference load: setEnabled(false), cancel.
OptOutApplies ==
  /\ optOut = "loading"
  /\ optOut' = "done" /\ enabled' = FALSE
  /\ CancelRetry
  /\ UNCHANGED <<stream, policy, pCap, errors, rGen, rStopGen, stopGen, latch, stop, spc,
                 cancelDebt, resumed, resumedAfterStop, stops, pStops, sStops>>
  /\ UNCHANGED restartVars

\* task: the stop record releases once the captured turn settled and the cleanup ended.
TaskStopReleases ==
  /\ spc = "awaitSettle" /\ ~Busy
  /\ spc' = "done" /\ latch' = latch - 1
  /\ UNCHANGED <<stream, policy, pCap, errors, enabled, gen, fiber, fGen, rpc, rGen, rStopGen,
                 stopGen, stop, optOut, cancelDebt, resumed, resumedAfterStop, stops, pStops, sStops>>
  /\ UNCHANGED restartVars

-----------------------------------------------------------------------------
(* The restart: the backend exits while no Stop is in progress, and a new   *)
(* one runs startup recovery (workspaceService.ts initialize, agentSession.ts *)
(* runStartupRecovery, scheduleStartupAutoRetryIfNeeded). The Stop can come *)
(* before the restart or during that recovery.                              *)

\* Every in-memory state is gone. What is on disk stays: the ui opt-out (enabled), the
\* cancellation record (cancelDebt) and the startup abandon marker. A crash inside a Stop
\* is out of scope.
Restart ==
  /\ boot = "first" /\ spc \in {"none", "done"}
  /\ boot' = "restarted"
  /\ stream' = "idle" /\ policy' = "none" /\ fiber' = "none" /\ rpc' = "idle" /\ latch' = 0
  /\ enabled' = (optOut # "done")
  /\ UNCHANGED <<pCap, errors, gen, fGen, rGen, rStopGen, stopGen, stops, pStops, sStops, stop,
                 spc, optOut, cancelDebt, resumed, resumedAfterStop, marker, stCap, sCap>>

\* The workspace is a sub-agent: runStartupRecovery skips it (TaskService owns its recovery).
SubAgent == StopKinds \cap {"task", "timeout"} # {}

\* runStartupRecovery captures autoRetryStops before its first await, then awaits the
\* metadata read and the earlier recovery steps (compaction recovery, follow-ups).
StartupBegins ==
  /\ boot = "restarted"
  /\ boot' = "recovering" /\ stCap' = stops
  /\ UNCHANGED <<stream, policy, pCap, errors, enabled, gen, fiber, fGen, rpc, rGen, rStopGen,
                 stopGen, latch, stops, pStops, sStops, stop, spc, optOut, cancelDebt, resumed,
                 resumedAfterStop, marker, sCap>>

\* scheduleStartupAutoRetryIfNeeded captures the retry generation before its first await,
\* then awaits the cancellation record, the preference, the tail read and the derivation.
StartupSchedules ==
  /\ boot = "recovering"
  /\ boot' = "scheduling" /\ sCap' = gen
  /\ UNCHANGED <<stream, policy, pCap, errors, enabled, gen, fiber, fGen, rpc, rGen, rStopGen,
                 stopGen, latch, stops, pStops, sStops, stop, spc, optOut, cancelDebt, resumed,
                 resumedAfterStop, marker, stCap>>

\* The scheduler stops at the cancellation record, the opt-out or a marker that matches the
\* tail; its handleStreamFailureForAutoRetry refuses a moved generation or Stop count, and
\* otherwise arms a retry of the interrupted tail.
StartupArms ==
  /\ boot = "scheduling"
  /\ boot' = "recovered"
  /\ IF SubAgent \/ cancelDebt \/ ~enabled \/ marker \/ sCap # gen \/ stCap # stops
       THEN UNCHANGED <<gen, fiber, fGen, rpc>>
       ELSE Schedule
  /\ UNCHANGED <<stream, policy, pCap, errors, enabled, rGen, rStopGen, stopGen, latch, stops,
                 pStops, sStops, stop, spc, optOut, cancelDebt, resumed, resumedAfterStop, marker,
                 stCap, sCap>>

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
  \/ OptOutApplies \/ TaskStopReleases \/ TurnAbandons \/ TurnRecords \/ TurnStopReleases
  \/ TimeoutFails \/ Restart \/ StartupBegins \/ StartupSchedules \/ StartupArms
  \/ Settled

Spec == Init /\ [][Next]_vars

Bounded == gen <= MaxGen
=============================================================================
