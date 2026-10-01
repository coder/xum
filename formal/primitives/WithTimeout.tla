----------------------------- MODULE WithTimeout -----------------------------
(***************************************************************************)
(* Model of raceWithAbortAndTimeout, src/node/utils/concurrency/           *)
(* withTimeout.ts, for one call and every starting situation: the input   *)
(* promise pending or already settled, no signal / live / already aborted, *)
(* with or without timeoutMs.                                              *)
(*                                                                         *)
(* Segments: the synchronous executor (:10-54); the promise reaction (a    *)
(* microtask, :32-42); the abort event (listeners run synchronously inside *)
(* whatever segment calls abort()); the timer callback (a macrotask: it    *)
(* runs only when no microtask is queued).                                 *)
(***************************************************************************)
EXTENDS Naturals

CONSTANT Mutant   \* "none" | "noCleanup" (settle() skips cleanup(), :24)

VARIABLES
  promise,      \* "pending" | "fulfilled" | "rejected"
  signal,       \* "none" | "live" | "aborted"
  hasTimeout,
  called,       \* the executor ran
  attached,     \* promise.then(onOk, onErr) registered (:32)
  reaction,     \* the reaction microtask is queued
  listener,     \* abort listener registered (:47)
  timerArmed,   \* :51
  settled,      \* :11 `settled`
  outcome,      \* "none" | "ok" | "rejected" | "timeout" | "aborted"
  outerCalls,   \* how many times the outer resolve/reject was called
  settledAtCall \* the input promise had settled before the call

vars == <<promise, signal, hasTimeout, called, attached, reaction, listener,
          timerArmed, settled, outcome, outerCalls, settledAtCall>>

Init ==
  /\ promise \in {"pending", "fulfilled", "rejected"}
  /\ signal \in {"none", "live", "aborted"}
  /\ hasTimeout \in BOOLEAN
  /\ called = FALSE
  /\ attached = FALSE
  /\ reaction = FALSE
  /\ listener = FALSE
  /\ timerArmed = FALSE
  /\ settled = FALSE
  /\ outcome = "none"
  /\ outerCalls = 0
  /\ settledAtCall = FALSE

\* :20-27 settle(): the guard, cleanup (:14-19), then resolve.
Settle(kind) ==
  IF settled
    THEN UNCHANGED <<settled, outcome, outerCalls, timerArmed, listener>>
    ELSE /\ settled' = TRUE
         /\ outcome' = kind
         /\ outerCalls' = outerCalls + 1
         /\ timerArmed' = (Mutant = "noCleanup" /\ timerArmed)
         /\ listener' = (Mutant = "noCleanup" /\ listener)

\* :10-54, the whole executor in the caller's segment.
Call ==
  /\ ~called
  /\ called' = TRUE
  /\ settledAtCall' = (promise # "pending")
  /\ attached' = TRUE                                   \* :32
  /\ reaction' = (promise # "pending")                  \* settled input: reaction queued
  /\ IF signal = "aborted"                              \* :43-46
       THEN /\ settled' = TRUE
            /\ outcome' = "aborted"
            /\ outerCalls' = outerCalls + 1
            /\ UNCHANGED <<listener, timerArmed>>
       ELSE /\ listener' = (signal = "live")            \* :47
            /\ timerArmed' = hasTimeout                 \* :50-53
            /\ UNCHANGED <<settled, outcome, outerCalls>>
  /\ UNCHANGED <<promise, signal, hasTimeout>>

\* The caller's work settles at some later point.
SettleInput ==
  /\ promise = "pending"
  /\ promise' \in {"fulfilled", "rejected"}
  /\ reaction' = attached
  /\ UNCHANGED <<signal, hasTimeout, called, attached, listener, timerArmed, settled,
                 outcome, outerCalls, settledAtCall>>

\* :33 and :34-41, the reaction microtask.
RunReaction ==
  /\ reaction
  /\ reaction' = FALSE
  /\ IF promise = "fulfilled" THEN Settle("ok") ELSE Settle("rejected")
  /\ UNCHANGED <<promise, signal, hasTimeout, called, attached, settledAtCall>>

\* Some segment calls controller.abort(); a registered listener runs synchronously.
Abort ==
  /\ signal = "live"
  /\ signal' = "aborted"
  /\ IF listener
       THEN Settle("aborted")
       ELSE UNCHANGED <<settled, outcome, outerCalls, timerArmed, listener>>
  /\ UNCHANGED <<promise, hasTimeout, called, attached, reaction, settledAtCall>>

\* :51 timer callback: a macrotask, so every queued microtask ran first.
TimerFire ==
  /\ timerArmed
  /\ ~reaction
  /\ Settle("timeout")
  /\ UNCHANGED <<promise, signal, hasTimeout, called, attached, reaction, settledAtCall>>

Quiet == called /\ ~reaction /\ ~timerArmed /\ promise # "pending" /\ signal # "live"

Next == Call \/ SettleInput \/ RunReaction \/ Abort \/ TimerFire \/ (Quiet /\ UNCHANGED vars)

Spec == Init /\ [][Next]_vars /\ WF_vars(Call) /\ WF_vars(RunReaction) /\ WF_vars(TimerFire)

-----------------------------------------------------------------------------
\* The returned promise settles at most once.
AtMostOnce == outerCalls <= 1

\* No retained listener or timer after the race settled.
NoLeakAfterSettle == settled => (~listener /\ ~timerArmed)

\* The outcome is backed by the event it names.
OutcomeValid ==
  /\ outcome = "ok" => promise = "fulfilled"
  /\ outcome = "rejected" => promise = "rejected"
  /\ outcome = "aborted" => signal = "aborted"
  /\ outcome = "timeout" => hasTimeout

\* :48-49: an input that settled before the call beats the timeout (even timeoutMs 0).
SettledInputBeatsTimeout == settledAtCall => outcome # "timeout"

\* A rejection is always observed: the handler is attached in the first segment.
RejectionObserved == called => attached

\* With a timeout the race always settles, whatever the input and the signal do.
SettlesWithTimeout == (hasTimeout /\ called) ~> settled
=============================================================================
