----------------------------- MODULE StreamRetry -----------------------------
(***************************************************************************)
(* Auto-retry and the other stream starters vs the user's Stop, for one   *)
(* workspace, at commit a186481add:                                        *)
(*   retryManager.ts       handleStreamFailure (:89-133): returns when     *)
(*       disabled (:95), bumps the generation, forks the backoff fiber;    *)
(*       fiber (:164-207) checks enabled + generation, then onRetry;       *)
(*       cancel (:251-255) bumps the generation                            *)
(*   agentSession.ts       handleStreamFailureForAutoRetry (:1915-1931)    *)
(*       captures the generation, awaits the preference, re-checks;        *)
(*       retryActiveStream (:1971) -> resumeStream (:5684): isBusy         *)
(*       (:5719), latch (:5761), coordinator.prepare(expectedTurnId)       *)
(*       (:5786), admissionStopEpoch (:5799), provider-start fence         *)
(*       (:8124-8127: no Stop in progress, same stop epoch)                *)
(*     sendMessage (:3906) -> prepareMessage (:4095): expectedTurn at      *)
(*       entry (:3933); preflight awaits (:4290-4893) with the coordinator *)
(*       still idle; every gate refuses once the turn id moved             *)
(*       (isAdmissionStale, :4107-4112); acceptance into history (:5291),  *)
(*       then awaits clearStartupAutoRetryAbandon, retryManager.cancel +   *)
(*       setEnabled(true), awaits persisting the preference (:5485-5493);  *)
(*       the PREPARING gate (:5531), coordinator.prepare "direct" (:5557)  *)
(*     interruptStream (:7483): retryManager.cancel (:7624), then         *)
(*       stopStream(user) (:7631); a user abort is non-retryable           *)
(*   workspaceService.ts   interruptStream (:16137): stop epoch + latch    *)
(*       (:16156-16164), opt-out started without await (:16211), the       *)
(*       session interrupt, ack only after the opt-out write (:16237),     *)
(*       latch released after the cascade (:16310/:16395)                  *)
(*   startup: scheduleStartupAutoRetryIfNeeded (:2926-3037) re-derives a   *)
(*       retry from the history tail unless the persisted preference is    *)
(*       off or an abandon marker matches; in-memory retry state is lost   *)
(* Turn ids: `turn` is the coordinator's turn id; prepare moves it.        *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
  MaxErrors,       \* provider errors the environment may inject
  HasManualSend,   \* the user sends a new message (once)
  CanCrash,        \* one crash/restart may happen
  MaxStops,        \* how many times the user may press Stop
  ManualFenced,    \* fix: a manual send blocks automatic admission from its entry
  NoRetryFence,    \* mutant: the retry ignores both cancel fences, its generation and its
                   \* abort signal (cancel() clears both at once, so fiberLive models both)
  NoOptOut,        \* mutant: Stop does not persist disableAutoRetry
  NoIdleGuard,     \* mutant: retry admission skips the coordinator's idle check (isBusy)
  AtomicReenable,  \* abstraction: a manual send's acceptance, its in-memory re-enable and the
                   \* persisted re-enable are one step (FALSE: three steps, as in the code)
  NoStopEnd        \* mutant: the user's Stop does not end the running turn

VARIABLES
  phase,       \* coordinator: "idle" | "preparing" | "streaming"
  streams,     \* turns admitted and not yet ended (an idle transition ends them all;
               \* OneStream fails at the second admission, before that can hide it)
  turn,        \* coordinator turn id
  owner,       \* who owns the current turn: "none" | "retry" | "manual"
  admEpoch,    \* stop epoch captured at admission
  errors,      \* provider errors so far
  lastErr,     \* the history tail is a retryable failure (startup re-derives a retry)
  \* retry
  fiberLive,   \* the backoff fiber's generation is still current (cancel/bump clears it)
  handlerLive, \* the failure handler's captured generation is still current
  enabled, persisted, rpc, rExpect,
  \* stop
  spc, epoch, latch, acked, optOutDone,
  \* manual send
  mpc, mExpect, manualAfterAck,
  mEpoch,      \* stop epoch when the manual send was accepted
  \* history
  autoAfterAck, manualRetired,
  userTail,    \* an accepted manual row is the history tail and no turn consumed it yet
  stranded,    \* a restart left an accepted manual send without its retry (see NoStrandedSend)
  crashed

vars == <<phase, streams, turn, owner, admEpoch, errors, lastErr, fiberLive, handlerLive, enabled,
          persisted, rpc, rExpect, spc, epoch, latch, acked, optOutDone, mpc, mExpect,
          manualAfterAck, mEpoch, autoAfterAck, manualRetired, userTail, stranded, crashed>>

MaxTurn == 5

Init ==
  /\ phase = "streaming" /\ streams = 1 /\ turn = 1 /\ owner = "manual" /\ admEpoch = 0
  /\ errors = 0 /\ lastErr = FALSE
  /\ fiberLive = FALSE /\ handlerLive = FALSE /\ enabled = TRUE /\ persisted = TRUE
  /\ rpc = "none" /\ rExpect = 0
  /\ spc = "idle" /\ epoch = 0 /\ latch = FALSE /\ acked = FALSE /\ optOutDone = FALSE
  /\ mpc = (IF HasManualSend THEN "idle" ELSE "none") /\ mExpect = 0 /\ manualAfterAck = FALSE
  /\ mEpoch = 0 /\ autoAfterAck = FALSE /\ manualRetired = FALSE /\ userTail = FALSE
  /\ stranded = FALSE /\ crashed = FALSE

\* From the send's entry until coordinator.prepare (accepted, enabled, persisted: the row is
\* durable; enabled: auto-retry is on in memory; persisted: the preference write landed).
ManualInFlight == mpc \in {"preflight", "accepted", "enabled", "persisted"}
\* retryManager.cancel() interrupts the fiber; its signal aborts a retry still starting
\* (resumeStream's startupController, :5694-5698). After provider start it is detached.
AbortStartingRetry ==
  IF owner = "retry" /\ phase = "preparing"
    THEN phase' = "idle" /\ owner' = "none" /\ streams' = 0
    ELSE UNCHANGED <<phase, owner, streams>>
\* After an acknowledged Stop, only a new user send may start a stream.
AfterAck == acked /\ ~manualAfterAck

---------------------------------------------------------------------------
(* Provider: the stream errors or ends.                                    *)
StreamError ==
  /\ phase = "streaming" /\ errors < MaxErrors
  /\ errors' = errors + 1 /\ lastErr' = TRUE
  /\ phase' = "idle" /\ owner' = "none" /\ streams' = 0
  /\ rpc' = "handler" /\ handlerLive' = TRUE        \* :1915 captured as a default parameter
  /\ UNCHANGED <<turn, admEpoch, fiberLive, enabled, persisted, rExpect, spc, epoch, latch, acked, optOutDone, mpc, mExpect, manualAfterAck, autoAfterAck, manualRetired, mEpoch, userTail, stranded, crashed>>
StreamEnd ==     \* handleStreamSuccess -> cancel (:9203)
  /\ phase = "streaming" /\ phase' = "idle" /\ owner' = "none" /\ streams' = 0 /\ lastErr' = FALSE
  /\ fiberLive' = FALSE /\ handlerLive' = FALSE /\ rpc' = "none"
  /\ UNCHANGED <<turn, admEpoch, errors, enabled, persisted, rExpect, spc, epoch, latch, acked, optOutDone, mpc, mExpect, manualAfterAck, autoAfterAck, manualRetired, mEpoch, userTail, stranded, crashed>>

---------------------------------------------------------------------------
(* Auto-retry.                                                             *)
Handler ==       \* :1930-1931 after the preference load: re-check, then schedule
  /\ rpc = "handler"
  /\ IF handlerLive /\ enabled               \* :99-100 bump, then the fiber holds the new one
       THEN rpc' = "backoff" /\ fiberLive' = TRUE
       ELSE rpc' = "none" /\ UNCHANGED fiberLive
  /\ handlerLive' = FALSE
  /\ UNCHANGED <<phase, streams, turn, owner, admEpoch, errors, lastErr, enabled, persisted, rExpect, spc, epoch, latch, acked, optOutDone, mpc, mExpect, manualAfterAck, autoAfterAck, manualRetired, mEpoch, userTail, stranded, crashed>>
Fire ==          \* :164-207 the sleep ends; enabled + generation, then resumeStream
  /\ rpc = "backoff"
  /\ IF enabled /\ (fiberLive \/ NoRetryFence)
       THEN rpc' = "resume" /\ rExpect' = turn          \* :5688 expectedTurnId
       ELSE rpc' = "none" /\ UNCHANGED rExpect
  /\ UNCHANGED <<phase, streams, turn, owner, admEpoch, errors, lastErr, fiberLive, handlerLive, enabled, persisted, spc, epoch, latch, acked, optOutDone, mpc, mExpect, manualAfterAck, autoAfterAck, manualRetired, mEpoch, userTail, stranded, crashed>>
Admit ==         \* :5719-5799 after the preflight awaits, one synchronous block
  /\ rpc = "resume"
  /\ IF (fiberLive \/ NoRetryFence)                    \* retrySignal (fiber interrupt)
        /\ (phase = "idle" \/ NoIdleGuard) /\ ~latch /\ turn = rExpect /\ turn < MaxTurn
        /\ ~(ManualFenced /\ ManualInFlight)
       THEN /\ phase' = "preparing" /\ streams' = streams + 1 /\ turn' = turn + 1 /\ owner' = "retry"
            /\ admEpoch' = epoch /\ rpc' = "none" /\ UNCHANGED handlerLive
            /\ userTail' = FALSE     \* the admitted turn's request includes the row
       ELSE /\ UNCHANGED <<phase, streams, turn, owner, admEpoch, userTail, crashed>>
            \* Fix: the fenced retry defers (started:false -> retry_deferred_busy reschedules
            \* through the failure handler); the send's acceptance or the user's Stop cancels it.
            /\ IF ManualFenced /\ ManualInFlight /\ (fiberLive \/ NoRetryFence)
                 THEN rpc' = "handler" /\ handlerLive' = TRUE
                 ELSE rpc' = "none" /\ UNCHANGED handlerLive
  /\ UNCHANGED <<errors, lastErr, fiberLive, enabled, persisted, rExpect, spc, epoch, latch, acked, optOutDone, mpc, mExpect, manualAfterAck, mEpoch, autoAfterAck, manualRetired, stranded, crashed>>

\* Provider start for whoever owns the PREPARING turn (:8124-8127 stop fence).
ProviderStart ==
  /\ phase = "preparing"
  /\ IF ~latch /\ admEpoch = epoch
       THEN /\ phase' = "streaming"
            /\ autoAfterAck' = (autoAfterAck \/ (owner = "retry" /\ AfterAck))
       ELSE /\ phase' = "idle" /\ UNCHANGED autoAfterAck
  /\ owner' = IF ~latch /\ admEpoch = epoch THEN owner ELSE "none"
  /\ streams' = IF ~latch /\ admEpoch = epoch THEN streams ELSE 0
  /\ UNCHANGED <<turn, admEpoch, errors, lastErr, fiberLive, handlerLive, enabled, persisted, rpc, rExpect, spc, epoch, latch, acked, optOutDone, mpc, mExpect, manualAfterAck, manualRetired, mEpoch, userTail, stranded, crashed>>

---------------------------------------------------------------------------
(* The user's manual send.                                                 *)
MStart ==        \* :3933 expectedTurn captured at entry; preflight awaits follow
  /\ mpc = "idle" /\ mpc' = "preflight" /\ mExpect' = turn
  /\ UNCHANGED <<phase, streams, turn, owner, admEpoch, errors, lastErr, fiberLive, handlerLive, enabled, persisted, rpc, rExpect, spc, epoch, latch, acked, optOutDone, manualAfterAck, autoAfterAck, manualRetired, mEpoch, userTail, stranded, crashed>>
\* retryManager.cancel + setEnabled(true) (:5491-5492): the send now owns the turn.
Reenable ==
  /\ fiberLive' = FALSE /\ handlerLive' = FALSE /\ rpc' = IF rpc = "backoff" THEN "none" ELSE rpc
  /\ AbortStartingRetry /\ enabled' = TRUE
MAccept ==       \* isAdmissionStale (:4107-4112: turn moved) and the latch (:4648) refuse at
                 \* each gate, e.g. right after the lease confirmation (:4306-4332), with
                 \* CONTEXT_MUTATION_SEND_BLOCKED_MESSAGE; else the row is durable (:5291)
  /\ mpc = "preflight"
  /\ IF latch \/ turn # mExpect
       THEN /\ mpc' = "done" /\ manualRetired' = (manualRetired \/ turn # mExpect)
            /\ UNCHANGED <<fiberLive, handlerLive, enabled, persisted, rpc, manualAfterAck, phase,
                           streams, owner, mEpoch, userTail>>
       ELSE /\ mpc' = IF AtomicReenable THEN "persisted" ELSE "accepted"
            /\ userTail' = TRUE /\ mEpoch' = epoch
            /\ manualAfterAck' = (manualAfterAck \/ acked)
            /\ IF AtomicReenable THEN Reenable /\ persisted' = TRUE
               ELSE UNCHANGED <<fiberLive, handlerLive, enabled, persisted, rpc, phase, streams, owner>>
            /\ UNCHANGED manualRetired
  /\ UNCHANGED <<turn, admEpoch, errors, lastErr, rExpect, spc, epoch, latch, acked, optOutDone,
                 mExpect, autoAfterAck, stranded, crashed>>
MReenable ==     \* :5488-5492 after awaiting clearStartupAutoRetryAbandon (:5489). Only isAdmissionStale
                 \* gates it, not the Stop latch; refuseStaleDurableSend keeps the durable row.
  /\ mpc = "accepted"
  /\ IF turn # mExpect
       THEN /\ mpc' = "done" /\ manualRetired' = TRUE
            /\ UNCHANGED <<fiberLive, handlerLive, enabled, rpc, phase, streams, owner>>
       ELSE /\ mpc' = "enabled" /\ Reenable /\ UNCHANGED manualRetired
  /\ UNCHANGED <<turn, admEpoch, errors, lastErr, persisted, rExpect, spc, epoch, latch, acked,
                 optOutDone, mExpect, manualAfterAck, mEpoch, autoAfterAck, userTail, stranded, crashed>>
MPersist ==      \* :5493 persistAutoRetryEnabledPreference(true) lands; it can land after a
                 \* concurrent Stop's opt-out write and overwrite it
  /\ mpc = "enabled" /\ mpc' = "persisted" /\ persisted' = TRUE
  /\ UNCHANGED <<phase, streams, turn, owner, admEpoch, errors, lastErr, fiberLive, handlerLive, enabled, rpc, rExpect, spc, epoch, latch, acked, optOutDone, mExpect, manualAfterAck, mEpoch, autoAfterAck, manualRetired, userTail, stranded, crashed>>
MPrepare ==      \* :5531 PREPARING gate (a Stop in progress refuses, the row stays durable);
                 \* :5557 prepare "direct": refused "retired" when the turn moved
  /\ mpc = "persisted"
  /\ IF turn = mExpect /\ phase = "idle" /\ ~latch /\ turn < MaxTurn
       THEN /\ phase' = "preparing" /\ streams' = streams + 1 /\ turn' = turn + 1 /\ owner' = "manual"
            /\ admEpoch' = epoch /\ UNCHANGED manualRetired /\ userTail' = FALSE
       ELSE /\ UNCHANGED <<phase, streams, turn, owner, admEpoch, userTail, crashed>>
            /\ manualRetired' = (manualRetired \/ turn # mExpect)   \* only an automatic admission moves it
  /\ mpc' = "done"
  /\ UNCHANGED <<errors, lastErr, fiberLive, handlerLive, enabled, persisted, rpc, rExpect, spc, epoch, latch, acked, optOutDone, mExpect, manualAfterAck, mEpoch, autoAfterAck, stranded, crashed>>

---------------------------------------------------------------------------
(* The user's Stop (WorkspaceService.interruptStream).                     *)
SBegin ==        \* :16156-16164 epoch + latch, synchronously. A later Stop (after a manual
                 \* send re-enabled auto-retry) starts a fresh cycle: its own ack and opt-out.
  /\ spc \in {"idle", "done"} /\ epoch < MaxStops
  /\ spc' = "cancel" /\ epoch' = epoch + 1 /\ latch' = TRUE
  /\ acked' = FALSE /\ optOutDone' = FALSE /\ manualAfterAck' = FALSE
  /\ UNCHANGED <<phase, streams, turn, owner, admEpoch, errors, lastErr, fiberLive, handlerLive, enabled, persisted, rpc, rExpect, mpc, mExpect, autoAfterAck, manualRetired, mEpoch, userTail, stranded, crashed>>
SOptOut ==       \* :16211 setAutoRetryEnabled(false), started without await (:5846-5854)
  /\ spc \in {"cancel", "stop", "ack"} /\ ~optOutDone
  /\ optOutDone' = TRUE
  /\ IF NoOptOut THEN UNCHANGED <<enabled, persisted, fiberLive, handlerLive, rpc, phase, streams, owner>>
     ELSE /\ enabled' = FALSE /\ persisted' = FALSE /\ fiberLive' = FALSE /\ handlerLive' = FALSE
          /\ rpc' = IF rpc \in {"backoff", "handler"} THEN "none" ELSE rpc
          /\ AbortStartingRetry
  /\ UNCHANGED <<turn, admEpoch, errors, lastErr, rExpect, spc, epoch, latch, acked, mpc, mExpect, manualAfterAck, autoAfterAck, manualRetired, mEpoch, userTail, stranded, crashed>>
SCancel ==       \* agentSession :7624 retryManager.cancel()
  /\ spc = "cancel" /\ fiberLive' = FALSE /\ handlerLive' = FALSE /\ spc' = "stop"
  /\ rpc' = IF rpc = "backoff" THEN "none" ELSE rpc
  /\ AbortStartingRetry
  /\ UNCHANGED <<turn, admEpoch, errors, lastErr, enabled, persisted, rExpect, epoch, latch, acked, optOutDone, mpc, mExpect, manualAfterAck, autoAfterAck, manualRetired, mEpoch, userTail, stranded, crashed>>
SStop ==         \* :7631 stopStream(user): aborts the turn; a user abort is non-retryable
  /\ spc = "stop"
  /\ IF phase # "idle" /\ ~NoStopEnd
       THEN phase' = "idle" /\ owner' = "none" /\ streams' = 0
            /\ lastErr' = FALSE   \* abandon marker (:9158)
       ELSE UNCHANGED <<phase, streams, owner, lastErr, crashed>>
  /\ spc' = "ack"
  /\ UNCHANGED <<turn, admEpoch, errors, fiberLive, handlerLive, enabled, persisted, rpc, rExpect, epoch, latch, acked, optOutDone, mpc, mExpect, manualAfterAck, autoAfterAck, manualRetired, mEpoch, userTail, stranded, crashed>>
SAck ==          \* :16237-16249 acknowledged once the opt-out write joined
  /\ spc = "ack" /\ optOutDone /\ acked' = TRUE /\ spc' = "release"
  /\ UNCHANGED <<phase, streams, turn, owner, admEpoch, errors, lastErr, fiberLive, handlerLive, enabled, persisted, rpc, rExpect, epoch, latch, optOutDone, mpc, mExpect, manualAfterAck, autoAfterAck, manualRetired, mEpoch, userTail, stranded, crashed>>
SRelease ==      \* :16310 / :16395 latch released after the cascade
  /\ spc = "release" /\ latch' = FALSE /\ spc' = "done"
  /\ UNCHANGED <<phase, streams, turn, owner, admEpoch, errors, lastErr, fiberLive, handlerLive, enabled, persisted, rpc, rExpect, epoch, acked, optOutDone, mpc, mExpect, manualAfterAck, autoAfterAck, manualRetired, mEpoch, userTail, stranded, crashed>>

---------------------------------------------------------------------------
(* Crash/restart: in-memory retry and stop state are lost; startup         *)
(* re-derives a retry from the history tail.                               *)
\* hasInterruptedStartupTail (:2907-2918): a retryable failure, a live turn's trailing user
\* row or unfinished partial, or an accepted manual row no turn consumed (also one the
\* PREPARING gate refused).
InterruptedTail == lastErr \/ phase # "idle" \/ userTail
Crash ==
  /\ CanCrash /\ ~crashed /\ crashed' = TRUE /\ spc \in {"idle", "done"}
  /\ phase' = "idle" /\ streams' = 0 /\ owner' = "none" /\ enabled' = persisted
  /\ lastErr' = InterruptedTail /\ userTail' = FALSE
  /\ rpc' = IF persisted /\ InterruptedTail THEN "backoff" ELSE "none"     \* :2926-3037
  /\ fiberLive' = TRUE /\ handlerLive' = FALSE
  /\ mpc' = IF ManualInFlight THEN "done" ELSE mpc
  \* The send was accepted after the user's last Stop, yet the preference still reads off.
  /\ stranded' = (userTail /\ ~persisted /\ mEpoch = epoch)
  /\ UNCHANGED <<turn, admEpoch, errors, persisted, rExpect, spc, epoch, latch, acked, optOutDone, mExpect, manualAfterAck, mEpoch, autoAfterAck, manualRetired>>

Next == StreamError \/ StreamEnd \/ Handler \/ Fire \/ Admit \/ ProviderStart
        \/ MStart \/ MAccept \/ MReenable \/ MPersist \/ MPrepare
        \/ SBegin \/ SOptOut \/ SCancel \/ SStop \/ SAck \/ SRelease \/ Crash
Spec == Init /\ [][Next]_vars

\* After the user's Stop is acknowledged, no automatic stream starts until the user sends.
NoStreamAfterStop == ~autoAfterAck
\* A retry never takes the turn a newer manual send was about to start (the send is
\* refused as "retired" and the retry replays the superseded request).
NoStaleRetry == ~manualRetired
\* At most one stream: the coordinator admits one turn at a time, a retry is never admitted
\* while one streams or prepares, and a live turn always has an owner.
OneStream == streams <= 1 /\ ((phase # "idle") => owner # "none")
\* The Stop leaves the workspace idle when it is acknowledged (the UI's busy state ends). The
\* latch is still held, so no new send can be admitted before the release.
StopSettles == (spc = "release") => phase = "idle"
\* A manual send accepted after the user's last Stop gets its retry after a restart, like the
\* same send once its re-enable is persisted. Leaving it for the user would make the restart's
\* behavior depend on when the crash hit the send's preference write.
NoStrandedSend == ~stranded

TypeOK == phase \in {"idle", "preparing", "streaming"} /\ streams \in 0..MaxTurn /\ turn \in 1..MaxTurn
          /\ rpc \in {"none", "handler", "backoff", "resume"}
=============================================================================
