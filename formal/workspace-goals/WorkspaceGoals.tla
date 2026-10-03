--------------------------- MODULE WorkspaceGoals ---------------------------
(***************************************************************************)
(* Autonomous turns of ONE top-level workspace at origin/main f30a1945a6:  *)
(* the goal loop (WorkspaceGoalService continuation candidates driven by   *)
(* the shared IdleDispatcher), heartbeats (HeartbeatService ->             *)
(* WorkspaceService.executeHeartbeat -> session queue), user sends, goal   *)
(* mutations by the user and the model, stream end/error, archive and app  *)
(* restart.                                                                *)
(*                                                                         *)
(* Code map (WGS = workspaceGoalService.ts, WS = workspaceService.ts,      *)
(* AS = agentSession.ts, HS = heartbeatService.ts):                        *)
(*  GDispatch    IdleDispatcher picks the goal consumer; dispatch() captures *)
(*               the admission generations (gdGen) and                     *)
(*               checkGoalContinuationEligibility captures the candidate   *)
(*               (WGS 2450) before awaiting isWorkspaceStreaming /         *)
(*               normalizeGoalLimits (WGS 2508-2521).                      *)
(*  GEligFinish  policy decision; a "stop + drop" deletes the candidate    *)
(*               slot BY KEY (WGS 2460), not by identity like              *)
(*               deletePendingCandidateIfStillSame (WGS 2434).             *)
(*  GAdmit       bridge send with the admissionStale probe (WGS 2316) and  *)
(*               requireIdle (WS 15273).                                   *)
(*  ArmStreamEnd requestContinuationAfterStreamEnd after finishTurn        *)
(*               (AS 9442, WGS 1711); skipped when a queued message was    *)
(*               waiting (AS 9365-9370).                                   *)
(*  KickoffArm   armKickoffContinuationIfIdle (WGS 4149-4230).             *)
(*  HbDispatch   HeartbeatService checkEligibility (HS 796-868).           *)
(*  HbSend       executeHeartbeat (WS 20194): no `enabled` re-check; a busy *)
(*               session queues the heartbeat (queueHeartbeatMessage).     *)
(*  TurnEnd      stream accounting (WGS 4667), pending goal mutation drain, *)
(*               then the session queue drains with no heartbeat-settings  *)
(*               check (AS sendQueuedMessages).                            *)
(*  Restart      in-memory candidate/dispatcher/queue/timers lost; goal.json *)
(*               persists; recoverPendingDispatchAfterRestart (WGS 4279).  *)
(*  pend         G4: the one goal advancement the session owes, with its   *)
(*               origin (AS pendingGoalAdvancement): "abandon" when a turn *)
(*               ends leaving it to queued automatic work that never        *)
(*               streams (FixAbandonAdvance), "error" after a terminal     *)
(*               stream error (FixErrorResume). ig is its fence.           *)
(*  Settle       AS reevaluateGoalAdvancement, the one wake-up path: once  *)
(*               no turn runs and nothing is queued it hands pend over     *)
(*               (WGS armGoalAdvancement: error rules only for "error")    *)
(*               and, with FixBlockedWake, re-requests a continuation whose *)
(*               dispatch stopped on queued input (blk).                   *)
(*  Withdraw     TaskService refuses or withdraws held-back queued work    *)
(*               and re-runs the idle drain (a queue mutation).            *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
  MaxGoals,          \* goal ids 1..MaxGoals (goal 1 exists initially)
  Cap,               \* turnCap of every goal (0 = none)
  MaxTurns,          \* bound on turns started (states at the bound are exempt)
  MaxUser,           \* bound on user actions
  MaxHbGen,          \* bound on heartbeat settings toggles
  MaxRestarts,
  HbMode,            \* "off" | "skip" | "queue" (queue = tool-end / turn-end)
  UserActs,          \* user sends and user goal mutations
  ExceptionActs,     \* G4 exceptions: user Stop, auto-retry opt-out, model pause
  ModelComplete,     \* complete_goal during a turn
  Errors,            \* terminal stream errors
  ArchiveOn,
  FixStaleDrop,      \* GEligFinish drops only the candidate it captured
  FixHbQueueRecheck, \* queued heartbeat re-checks the settings at dequeue
  FixHbSendRecheck,  \* executeHeartbeat re-checks the settings before sending
  MutNoProbe,        \* mutant: no admissionStale probe (sanity check)
  FixErrorResume,    \* G4 fix: a terminal stream error arms a bounded resume of an active goal
  MaxErrResume,      \* resumes per failure episode (GOAL_STREAM_ERROR_RESUME_MAX_ATTEMPTS)
  AbandonActs,       \* a queued automatic turn can be refused or withdrawn at its dispatch
  FixAbandonAdvance, \* G4 fix: abandoned automatic work hands the goal continuation back
  FixBlockedWake     \* G4 fix: removing queued input re-requests a continuation it blocked

VARIABLES
  gid, gst, used, wrapped, ack, nextId, igen,   \* goal.json (+ identity/pause/terminal generation)
  cand, nextObj,                                \* pending continuation candidate slot
  gd, gdCand, gdGen, dreqG, dreqH, dbusy, retry,\* IdleDispatcher + goal dispatch
  turn, turns, userQ, hbQ, pendRepl,            \* session
  arm, kick, recov,                             \* async follow-ups still to run
  hbOn, hbGen, hbFlight, archived, restarts, uacts,
  errN, optOut, errObjs,                        \* G4 resume episode, auto-retry opt-out
  pend, blk,                                    \* G4 pending advancement, blocked continuation
  badCont, badHb, dupFire, fired, errStall      \* ghosts

goalVars == <<gid, gst, used, wrapped, ack, nextId, igen>>
dispVars == <<gd, gdCand, gdGen, dreqG, dreqH, dbusy, retry>>
sessVars == <<turn, turns, userQ, hbQ, pendRepl>>
followVars == <<arm, kick, recov>>
miscVars == <<hbOn, hbGen, hbFlight, archived, restarts, uacts, errN, optOut, errObjs>>
ghostVars == <<badCont, badHb, dupFire, fired, errStall>>
advVars == <<pend, blk>>
vars == <<goalVars, cand, nextObj, dispVars, sessVars, followVars, miscVars, ghostVars, advVars>>

NoCand == [g |-> 0, o |-> 0]
NoTurn == [o |-> "none", g |-> 0]
NoPend == [o |-> "none", ig |-> 0]
Busy == turn.o # "none"
QueueEmpty == ~userQ /\ ~hbQ
CanStart == ~archived /\ turns < MaxTurns
NewCand == [g |-> gid, o |-> nextObj]
GoalStatuses == {"none", "active", "paused", "limited", "complete"}
Resumable(s) == s \in {"active", "limited"}

Init ==
  /\ gid = 1 /\ gst = "active" /\ used = 0 /\ wrapped = FALSE /\ ack = FALSE
  /\ nextId = 2 /\ igen = 0
  \* An armed candidate for goal 1 with a dispatch request (a stream end or a kickoff).
  /\ cand = [g |-> 1, o |-> 1] /\ nextObj = 2
  /\ gd = "idle" /\ gdCand = NoCand /\ gdGen = 0 /\ dreqG = TRUE /\ dreqH = FALSE
  /\ dbusy = "none" /\ retry = FALSE
  /\ turn = NoTurn /\ turns = 0 /\ userQ = FALSE /\ hbQ = FALSE /\ pendRepl = FALSE
  /\ arm = FALSE /\ kick = FALSE /\ recov = FALSE
  /\ hbOn = (HbMode # "off") /\ hbGen = 0 /\ hbFlight = "idle" /\ archived = FALSE
  /\ restarts = 0 /\ uacts = 0 /\ errN = 0 /\ optOut = FALSE /\ errObjs = {}
  /\ badCont = FALSE /\ badHb = FALSE /\ dupFire = FALSE /\ fired = {} /\ errStall = "none"
  /\ pend = NoPend /\ blk = FALSE

-----------------------------------------------------------------------------
(* Goal dispatch                                                           *)

GDispatch ==
  /\ dbusy = "none" /\ dreqG
  /\ dbusy' = "goal" /\ dreqG' = FALSE /\ gd' = "elig" /\ gdCand' = cand /\ gdGen' = igen
  \* Every check supersedes an earlier block; it records its own (WGS
  \* continuationsBlockedByUserInput).
  /\ blk' = FALSE
  /\ UNCHANGED <<goalVars, cand, nextObj, dreqH, retry, sessVars, followVars, miscVars, ghostVars,
                 pend>>

GDone == gd' = "idle" /\ dbusy' = "none" /\ gdCand' = NoCand

\* The eligibility check resumes after its awaits and evaluates the CAPTURED candidate against
\* the goal it reads now.
GEligFinish ==
  /\ gd = "elig"
  /\ IF gdCand = NoCand THEN
       /\ GDone /\ UNCHANGED <<cand, retry>>
     ELSE IF Busy THEN
       \* defer("currently_streaming"): the 1 s re-request timer.
       /\ GDone /\ retry' = TRUE /\ UNCHANGED cand
     ELSE IF ~QueueEmpty THEN
       \* stop("queued_user_input"): keep the candidate, schedule no retry.
       /\ GDone /\ UNCHANGED <<cand, retry>>
     ELSE IF gdCand.g # gid \/ ~(gst = "active" \/ (gst = "limited" /\ ~wrapped)) THEN
       \* stop + dropCandidate (goal_mismatch / goal_not_active / wrap-up already fired).
       /\ GDone /\ UNCHANGED retry
       /\ cand' = IF FixStaleDrop THEN (IF cand = gdCand THEN NoCand ELSE cand) ELSE NoCand
     ELSE IF ack THEN
       /\ GDone /\ UNCHANGED <<cand, retry>>   \* requires_ack: stop, keep candidate
     ELSE
       /\ gd' = "admit" /\ UNCHANGED <<dbusy, gdCand, cand, retry>>
  /\ blk' = (gdCand # NoCand /\ ~Busy /\ ~QueueEmpty)
  /\ UNCHANGED <<goalVars, nextObj, gdGen, dreqG, dreqH, sessVars, followVars, miscVars, ghostVars,
                 pend>>

GAdmit ==
  /\ gd = "admit"
  /\ LET stale == igen # gdGen \/ cand # gdCand IN
     IF stale /\ ~MutNoProbe THEN
       /\ GDone /\ UNCHANGED <<goalVars, cand, retry, sessVars, ghostVars, pend>>
     ELSE IF Busy THEN
       /\ GDone /\ retry' = TRUE /\ UNCHANGED <<goalVars, cand, sessVars, ghostVars, pend>>
     ELSE IF ~CanStart THEN
       /\ GDone /\ UNCHANGED <<goalVars, cand, retry, sessVars, ghostVars, pend>>
     ELSE
       /\ GDone /\ UNCHANGED retry
       /\ turn' = [o |-> IF gst = "limited" THEN "wrap" ELSE "cont", g |-> gdCand.g]
       /\ turns' = turns + 1
       /\ wrapped' = (wrapped \/ gst = "limited")
       /\ cand' = IF cand = gdCand THEN NoCand ELSE cand
       /\ badCont' = (badCont \/ gdCand.g # gid \/ ~Resumable(gst))
       /\ dupFire' = (dupFire \/ gdCand.o \in fired)
       /\ fired' = fired \cup {gdCand.o}
       /\ errStall' = "none"
       /\ pend' = NoPend                      \* a started stream owns its own end
       /\ UNCHANGED <<gid, gst, used, ack, nextId, igen, userQ, hbQ, pendRepl, badHb>>
  /\ UNCHANGED <<nextObj, gdGen, dreqG, dreqH, followVars, miscVars, blk>>

Retry ==
  /\ retry /\ retry' = FALSE
  /\ dreqG' = (dreqG \/ cand # NoCand)
  /\ UNCHANGED <<goalVars, cand, nextObj, gd, gdCand, gdGen, dreqH, dbusy, sessVars,
                 followVars, miscVars, ghostVars, advVars>>

ArmStreamEnd ==
  /\ arm /\ arm' = FALSE
  /\ IF gid # 0 /\ Resumable(gst) THEN
       cand' = NewCand /\ nextObj' = nextObj + 1 /\ dreqG' = TRUE
     ELSE
       cand' = NoCand /\ UNCHANGED <<nextObj, dreqG>>
  /\ UNCHANGED <<goalVars, gd, gdCand, gdGen, dreqH, dbusy, retry, sessVars, kick, recov,
                 miscVars, ghostVars, advVars>>

KickoffArm ==
  /\ kick /\ kick' = FALSE
  /\ IF gst = "active" /\ cand.g # gid THEN
       cand' = NewCand /\ nextObj' = nextObj + 1 /\ dreqG' = TRUE
     ELSE IF gst = "active" THEN
       dreqG' = TRUE /\ UNCHANGED <<cand, nextObj>>
     ELSE UNCHANGED <<cand, nextObj, dreqG>>
  /\ UNCHANGED <<goalVars, gd, gdCand, gdGen, dreqH, dbusy, retry, sessVars, arm, recov,
                 miscVars, ghostVars, advVars>>

-----------------------------------------------------------------------------
(* Turns                                                                   *)

\* Stream end: accounting charges the goal the turn ran for, the pending (mid-stream) goal
\* mutation drains, then the session queue drains; the stream-end continuation hook runs only
\* when no queued message was waiting.
TurnEnd ==
  /\ Busy
  /\ LET charge == turn.o \in {"cont", "wrap"} /\ turn.g = gid /\ Resumable(gst)
         used1 == IF charge THEN used + 1 ELSE used
         st1 == IF charge /\ gst = "active" /\ Cap > 0 /\ used1 >= Cap THEN "limited" ELSE gst
         repl == pendRepl /\ nextId <= MaxGoals
         hbStale == FixHbQueueRecheck /\ ~hbOn
     IN
     \E drop \in (IF AbandonActs THEN BOOLEAN ELSE {FALSE}) :
     /\ gid' = IF repl THEN nextId ELSE gid
     /\ gst' = IF repl THEN "active" ELSE st1
     /\ used' = IF repl THEN 0 ELSE used1
     /\ wrapped' = IF repl THEN FALSE ELSE wrapped
     /\ nextId' = IF repl THEN nextId + 1 ELSE nextId
     /\ igen' = IF repl THEN igen + 1 ELSE igen
     /\ kick' = (kick \/ repl)
     /\ pendRepl' = FALSE
     \* A stream that ended normally starts a new error-resume episode.
     /\ errN' = 0
     /\ IF userQ /\ CanStart THEN
          /\ turn' = [o |-> "user", g |-> gid'] /\ turns' = turns + 1
          /\ userQ' = FALSE /\ cand' = NoCand /\ arm' = FALSE
          /\ UNCHANGED <<hbQ, badHb, errStall, pend>>
        ELSE IF hbQ /\ (hbStale \/ drop) THEN
          \* The queued automatic turn never streams: a stale heartbeat dropped at the drain (G2
          \* fix), or (AbandonActs) any queued automatic turn refused or withdrawn at its dispatch,
          \* including a tool-end successor withdrawn after its soft stop. The ended turn left the
          \* goal continuation to it; with FixAbandonAdvance AgentSession records it as the pending
          \* advancement (fenced by the goal generation after the stream-end drain), and Settle
          \* hands it over once nothing blocks it.
          /\ turn' = NoTurn /\ hbQ' = FALSE /\ arm' = FALSE
          /\ pend' = IF FixAbandonAdvance THEN [o |-> "abandon", ig |-> igen'] ELSE pend
          /\ UNCHANGED <<turns, userQ, cand, badHb, errStall>>
        ELSE IF hbQ /\ CanStart THEN
          /\ turn' = [o |-> "hb", g |-> gid'] /\ turns' = turns + 1
          /\ hbQ' = FALSE /\ arm' = FALSE
          /\ badHb' = (badHb \/ ~hbOn)
          /\ UNCHANGED <<userQ, cand, errStall, pend>>
        ELSE
          /\ turn' = NoTurn /\ arm' = QueueEmpty
          /\ UNCHANGED <<turns, userQ, hbQ, cand, badHb, errStall, pend>>
  /\ UNCHANGED <<ack, nextObj, dispVars, recov, hbOn, hbGen, hbFlight, archived, restarts, uacts,
                 optOut, errObjs, badCont, dupFire, fired, blk>>

\* Terminal stream error: the accounting snapshot is restored and the queue is left for the next
\* turn (AS handleStreamError). Pre-fix nothing else happens. With FixErrorResume an active goal
\* without a pending user acknowledgment gets a pending "error" advancement unless the user opted
\* out of automatic retries; Settle applies the episode bound. errStall records why a goal was
\* left idle. (Retryable errors, which RetryManager resumes as the same stream, are a TurnError
\* followed by that stream's eventual TurnEnd or TurnError here: not modeled separately.)
TurnError ==
  /\ Errors /\ Busy
  /\ turn' = NoTurn
  /\ LET resumable == gid # 0 /\ gst = "active" /\ ~ack IN
     IF FixErrorResume /\ resumable /\ ~optOut THEN
       /\ pend' = [o |-> "error", ig |-> igen]
       /\ UNCHANGED errStall
     ELSE
       /\ UNCHANGED pend
       /\ errStall' = IF FixErrorResume /\ resumable THEN "optout" ELSE "none"
  /\ UNCHANGED <<goalVars, cand, nextObj, gd, gdCand, gdGen, dreqG, dreqH, dbusy, retry, turns,
                 userQ, hbQ, pendRepl, followVars, hbOn, hbGen, hbFlight, archived, restarts, uacts,
                 errN, optOut, errObjs, badCont, badHb, dupFire, fired, blk>>

\* AS reevaluateGoalAdvancement, the one wake-up path. Enabled once no turn runs and nothing is
\* queued (every blocker re-runs it when it clears: turn end, queue mutation). It hands the
\* pending advancement over exactly once (pend is cleared): nothing is armed when its fence moved
\* (goal replaced, paused, completed, limited; user Stop; for "error" also an opt-out), an
\* "error" advancement is bounded by MaxErrResume per episode, and an "abandon" one keeps a
\* candidate already armed for the goal (neither inheriting nor bypassing the error rules). With
\* FixBlockedWake it also re-requests a continuation whose dispatch stopped on queued input.
Settle ==
  /\ ~Busy /\ QueueEmpty
  /\ pend.o # "none" \/ (FixBlockedWake /\ blk)
  /\ pend' = NoPend
  /\ blk' = IF FixBlockedWake THEN FALSE ELSE blk
  /\ LET valid == pend.o # "none" /\ pend.ig = igen /\ gst = "active" /\ ~ack
         optedOut == pend.o = "error" /\ optOut
         armErr == valid /\ ~optedOut /\ pend.o = "error" /\ errN < MaxErrResume
         armAbandon == valid /\ pend.o = "abandon" /\ cand.g # gid
         reqAbandon == valid /\ pend.o = "abandon"
         wake == FixBlockedWake /\ blk /\ cand # NoCand
     IN
     /\ cand' = IF armErr \/ armAbandon THEN NewCand ELSE cand
     /\ nextObj' = IF armErr \/ armAbandon THEN nextObj + 1 ELSE nextObj
     /\ dreqG' = (dreqG \/ armErr \/ reqAbandon \/ wake)
     /\ errN' = IF armErr THEN errN + 1 ELSE errN
     \* Only UserOptOut reads errObjs: leave it empty without ExceptionActs to bound the state space.
     /\ errObjs' = IF armErr /\ ExceptionActs THEN errObjs \cup {nextObj} ELSE errObjs
     /\ errStall' = IF valid /\ optedOut THEN "optout"
                    ELSE IF valid /\ pend.o = "error" /\ ~armErr THEN "exhausted"
                    ELSE IF armErr THEN "none"
                    ELSE errStall
  /\ UNCHANGED <<goalVars, gd, gdCand, gdGen, dreqH, dbusy, retry, sessVars, followVars,
                 hbOn, hbGen, hbFlight, archived, restarts, uacts, optOut,
                 badCont, badHb, dupFire, fired>>

\* TaskService refuses or withdraws held-back queued automatic work and re-runs the idle drain:
\* the queue empties without a turn.
Withdraw ==
  /\ AbandonActs /\ ~Busy /\ hbQ /\ hbQ' = FALSE
  /\ UNCHANGED <<goalVars, cand, nextObj, dispVars, turn, turns, userQ, pendRepl, followVars,
                 miscVars, ghostVars, advVars>>

-----------------------------------------------------------------------------
(* User and model                                                          *)

UserStep == UserActs /\ uacts < MaxUser /\ uacts' = uacts + 1

UserSend ==
  /\ UserStep /\ (Busy \/ CanStart)
  /\ ack' = FALSE                               \* acknowledgeUser
  /\ cand' = NoCand                             \* takePendingContinuationCandidateForManualUserMessage
  /\ hbQ' = FALSE                               \* new input supersedes a queued heartbeat (WS 15389)
  \* An accepted manual send re-enables automatic retries (AS sendMessage).
  /\ optOut' = FALSE
  /\ IF Busy THEN userQ' = TRUE /\ UNCHANGED <<turn, turns, errStall, pend>>
     ELSE turn' = [o |-> "user", g |-> gid] /\ turns' = turns + 1 /\ errStall' = "none"
                 /\ pend' = NoPend /\ UNCHANGED userQ
  /\ UNCHANGED <<gid, gst, used, wrapped, nextId, igen, nextObj, dispVars, pendRepl, followVars,
                 hbOn, hbGen, hbFlight, archived, restarts, errN, errObjs,
                 badCont, badHb, dupFire, fired, blk>>

UserReplace ==
  /\ UserStep /\ nextId <= MaxGoals
  /\ IF Busy THEN
       \* Mid-stream replacement is a pending mutation applied at stream end.
       /\ pendRepl' = TRUE /\ UNCHANGED <<goalVars, kick>>
     ELSE
       /\ gid' = nextId /\ nextId' = nextId + 1 /\ gst' = "active" /\ used' = 0
       /\ wrapped' = FALSE /\ igen' = igen + 1 /\ kick' = TRUE
       /\ UNCHANGED <<ack, pendRepl>>
  \* An activation or edit is fresh consent: a new error-resume episode (WGS setGoal).
  /\ errN' = 0
  /\ UNCHANGED <<cand, nextObj, dispVars, turn, turns, userQ, hbQ, arm, recov,
                 hbOn, hbGen, hbFlight, archived, restarts, optOut, errObjs, ghostVars, advVars>>

UserPause ==
  /\ UserStep /\ gst = "active"
  /\ gst' = "paused" /\ igen' = igen + 1 /\ cand' = NoCand
  /\ UNCHANGED <<gid, used, wrapped, ack, nextId, nextObj, dispVars, sessVars, followVars,
                 hbOn, hbGen, hbFlight, archived, restarts, errN, optOut, errObjs, ghostVars, advVars>>

UserResume ==
  /\ UserStep /\ gst = "paused"
  /\ gst' = "active" /\ igen' = igen + 1 /\ kick' = TRUE /\ errN' = 0
  /\ UNCHANGED <<gid, used, wrapped, ack, nextId, cand, nextObj, dispVars, sessVars, arm, recov,
                 hbOn, hbGen, hbFlight, archived, restarts, optOut, errObjs, ghostVars, advVars>>

UserClear ==
  /\ UserStep /\ gid # 0 /\ ~Busy
  /\ gid' = 0 /\ gst' = "none" /\ used' = 0 /\ igen' = igen + 1 /\ cand' = NoCand
  /\ UNCHANGED <<wrapped, ack, nextId, nextObj, dispVars, sessVars, followVars,
                 hbOn, hbGen, hbFlight, archived, restarts, errN, optOut, errObjs, ghostVars, advVars>>

\* The model completes (complete_goal) or, with ExceptionActs, pauses the goal during a turn.
ModelCompletes ==
  /\ ModelComplete /\ Busy /\ Resumable(gst)
  /\ \E st \in IF ExceptionActs THEN {"complete", "paused"} ELSE {"complete"} : gst' = st
  /\ igen' = igen + 1
  /\ UNCHANGED <<gid, used, wrapped, ack, nextId, cand, nextObj, dispVars, sessVars, followVars,
                 miscVars, ghostVars, advVars>>

\* User Stop of a running turn (WS interruptStream -> AS abort -> WGS recordUserStoppedStream):
\* the candidate and a pending goal mutation are dropped, the stream-end drain and hook are
\* skipped, and a resumable goal requires user acknowledgment.
UserStop ==
  /\ ExceptionActs /\ UserStep /\ Busy
  /\ turn' = NoTurn /\ cand' = NoCand /\ pendRepl' = FALSE
  /\ ack' = (ack \/ (gid # 0 /\ Resumable(gst)))
  /\ UNCHANGED <<gid, gst, used, wrapped, nextId, igen, nextObj, dispVars, turns, userQ, hbQ,
                 followVars, hbOn, hbGen, hbFlight, archived, restarts, errN, optOut, errObjs,
                 ghostVars, advVars>>

\* The user opts out of automatic retries (AS setAutoRetryEnabled(false), e.g. a RetryBarrier
\* Stop): a pending error resume is dropped (WGS cancelStreamErrorResume).
UserOptOut ==
  /\ ExceptionActs /\ UserStep /\ ~optOut
  /\ optOut' = TRUE
  /\ cand' = IF cand.o \in errObjs THEN NoCand ELSE cand
  /\ errStall' = IF cand.o \in errObjs THEN "optout" ELSE errStall
  /\ UNCHANGED <<goalVars, nextObj, dispVars, sessVars, followVars, hbOn, hbGen, hbFlight,
                 archived, restarts, errN, errObjs, badCont, badHb, dupFire, fired, advVars>>

-----------------------------------------------------------------------------
(* Heartbeats                                                              *)

HbFire ==
  /\ HbMode # "off" /\ hbOn /\ ~archived /\ ~dreqH /\ hbFlight = "idle"
  /\ dreqH' = TRUE
  /\ UNCHANGED <<goalVars, cand, nextObj, gd, gdCand, gdGen, dreqG, dbusy, retry, sessVars,
                 followVars, miscVars, ghostVars, advVars>>

\* Goal priority: the dispatcher serves a pending goal request first.
HbDispatch ==
  /\ dbusy = "none" /\ dreqH /\ ~dreqG
  /\ dreqH' = FALSE
  /\ IF hbOn /\ ~archived /\ ~(HbMode = "skip" /\ Busy) THEN
       dbusy' = "hb" /\ hbFlight' = "send"
     ELSE UNCHANGED <<dbusy, hbFlight>>
  /\ UNCHANGED <<goalVars, cand, nextObj, gd, gdCand, gdGen, dreqG, retry, sessVars, followVars,
                 hbOn, hbGen, archived, restarts, uacts, errN, optOut, errObjs, ghostVars, advVars>>

HbSend ==
  /\ hbFlight = "send"
  /\ hbFlight' = "idle" /\ dbusy' = "none"
  /\ IF FixHbSendRecheck /\ (~hbOn \/ archived) THEN
       UNCHANGED <<turn, turns, hbQ, badHb, errStall, pend>>
     ELSE IF Busy THEN
       \* skip mode throws; queue modes queue unless any message is queued.
       /\ hbQ' = (hbQ \/ (HbMode = "queue" /\ ~userQ))
       /\ UNCHANGED <<turn, turns, badHb, errStall, pend>>
     ELSE IF CanStart THEN
       /\ turn' = [o |-> "hb", g |-> gid] /\ turns' = turns + 1
       /\ badHb' = (badHb \/ ~hbOn) /\ errStall' = "none"
       /\ pend' = NoPend
       /\ UNCHANGED hbQ
     ELSE UNCHANGED <<turn, turns, hbQ, badHb, errStall, pend>>
  /\ UNCHANGED <<goalVars, cand, nextObj, gd, gdCand, gdGen, dreqG, dreqH, retry, userQ,
                 pendRepl, followVars, hbOn, hbGen, archived, restarts, uacts, errN, optOut,
                 errObjs, badCont, dupFire, fired, blk>>

\* The user or the model (heartbeat tool) enables, disables or unsets the heartbeat.
HbToggle ==
  /\ HbMode # "off" /\ hbGen < MaxHbGen
  /\ hbOn' = ~hbOn /\ hbGen' = hbGen + 1
  /\ UNCHANGED <<goalVars, cand, nextObj, dispVars, sessVars, followVars, hbFlight, archived,
                 restarts, uacts, errN, optOut, errObjs, ghostVars, advVars>>

-----------------------------------------------------------------------------
(* Archive and restart                                                     *)

\* Archive interrupts the stream and holds turn admission (queued entries included).
Archive ==
  /\ ArchiveOn /\ ~archived
  /\ archived' = TRUE /\ turn' = NoTurn
  /\ UNCHANGED <<goalVars, cand, nextObj, dispVars, turns, userQ, hbQ, pendRepl, followVars,
                 hbOn, hbGen, hbFlight, restarts, uacts, errN, optOut, errObjs, ghostVars, advVars>>

Restart ==
  /\ restarts < MaxRestarts /\ restarts' = restarts + 1
  \* A crash-recovered partial of a goal-active workspace requires user acknowledgment.
  /\ ack' = (ack \/ (Busy /\ Resumable(gst)))
  /\ cand' = NoCand /\ gd' = "idle" /\ gdCand' = NoCand /\ dreqG' = FALSE /\ dreqH' = FALSE
  /\ dbusy' = "none" /\ retry' = FALSE
  /\ turn' = NoTurn /\ userQ' = FALSE /\ hbQ' = FALSE /\ pendRepl' = FALSE
  /\ arm' = FALSE /\ kick' = FALSE /\ recov' = TRUE /\ hbFlight' = "idle"
  \* The resume episode is in memory; the auto-retry opt-out is persisted.
  /\ errStall' = "none" /\ errN' = 0
  \* The pending advancement and the block flag are in memory too.
  /\ pend' = NoPend /\ blk' = FALSE
  /\ UNCHANGED <<gid, gst, used, wrapped, nextId, igen, nextObj, gdGen, turns, hbOn, hbGen,
                 archived, uacts, optOut, errObjs, badCont, badHb, dupFire, fired>>

Recover ==
  /\ recov /\ recov' = FALSE
  /\ IF ~ack /\ (gst = "active" \/ (gst = "limited" /\ ~wrapped)) THEN
       cand' = NewCand /\ nextObj' = nextObj + 1 /\ dreqG' = TRUE
     ELSE UNCHANGED <<cand, nextObj, dreqG>>
  /\ UNCHANGED <<goalVars, gd, gdCand, gdGen, dreqH, dbusy, retry, sessVars, arm, kick,
                 miscVars, ghostVars, advVars>>

Next ==
  \/ GDispatch \/ GEligFinish \/ GAdmit \/ Retry \/ ArmStreamEnd \/ KickoffArm
  \/ TurnEnd \/ TurnError \/ Settle \/ Withdraw
  \/ UserSend \/ UserReplace \/ UserPause \/ UserResume \/ UserClear \/ ModelCompletes
  \/ UserStop \/ UserOptOut
  \/ HbFire \/ HbDispatch \/ HbSend \/ HbToggle
  \/ Archive \/ Restart \/ Recover

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* Invariants                                                              *)

TypeOK ==
  /\ gid \in 0..MaxGoals /\ gst \in GoalStatuses /\ (gid = 0) = (gst = "none")
  /\ used \in 0..(MaxTurns + 1) /\ igen \in Nat
  /\ cand.g \in 0..MaxGoals /\ gdCand.g \in 0..MaxGoals
  /\ gd \in {"idle", "elig", "admit"} /\ dbusy \in {"none", "goal", "hb"}
  /\ turn.o \in {"none", "user", "cont", "wrap", "hb"}
  /\ hbFlight \in {"idle", "send"}
  /\ errN \in 0..MaxErrResume /\ errStall \in {"none", "exhausted", "optout"}
  /\ pend.o \in {"none", "error", "abandon"} /\ blk \in BOOLEAN

\* Nothing internal is left to run: no turn, no dispatch request or check, no timer, no
\* queued message, no follow-up. States at the turn bound, archived workspaces and workspaces
\* whose enabled heartbeat would still wake them are excluded.
Quiescent ==
  /\ ~Busy /\ gd = "idle" /\ dbusy = "none" /\ ~dreqG /\ ~dreqH /\ ~retry
  /\ ~arm /\ ~kick /\ ~recov /\ hbFlight = "idle" /\ QueueEmpty
  /\ pend.o = "none" /\ ~(FixBlockedWake /\ blk)
  /\ turns < MaxTurns /\ ~archived /\ ~(HbMode # "off" /\ hbOn)

\* An active goal that does not wait for the user is never left with nothing able to drive it,
\* except after a terminal stream error whose bounded resumes are spent or after the user opted
\* out of automatic retries (G4). A paused, completed or limited goal is not "active", and a
\* user Stop leaves it waiting for acknowledgment (ack).
NoStrandedGoal == (Quiescent /\ gst = "active" /\ ~ack) => errStall # "none"

\* G4: every pending advancement, and every continuation whose dispatch stopped on queued input,
\* has a scheduled wake (a dispatch request, check or retry timer) or a blocker whose removal
\* re-evaluates it: a running turn, queued work (its removal enables Settle), or Settle itself.
\* Settle consumes pend and blk, so each is re-evaluated once. States at the turn bound and
\* archived workspaces are excluded.
SettleEnabled == ~Busy /\ QueueEmpty /\ (pend.o # "none" \/ (FixBlockedWake /\ blk))
PendingAdvancementWoken ==
  (pend.o # "none" \/ (blk /\ cand # NoCand)) =>
    \/ Busy \/ ~QueueEmpty \/ SettleEnabled \/ dreqG \/ retry \/ gd # "idle"
    \/ archived \/ turns >= MaxTurns

\* A continuation (or wrap-up) only starts for the current goal while it is resumable.
NoStaleContinuation == ~badCont

\* A heartbeat turn never starts while the heartbeat is disabled or unset.
NoHeartbeatWhenOff == ~badHb

\* No candidate (stream-end boundary or kickoff) fires two continuations.
NoDoubleFire == ~dupFire

\* At most one wrap-up turn past the cap.
UsedBounded == Cap = 0 \/ used <= Cap + 1

NoTurnWhenArchived == archived => ~Busy
=============================================================================
