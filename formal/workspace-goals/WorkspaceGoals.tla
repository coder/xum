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
  ModelComplete,     \* complete_goal during a turn
  Errors,            \* terminal stream errors
  ArchiveOn,
  FixStaleDrop,      \* GEligFinish drops only the candidate it captured
  FixHbQueueRecheck, \* queued heartbeat re-checks the settings at dequeue
  FixHbSendRecheck,  \* executeHeartbeat re-checks the settings before sending
  MutNoProbe,        \* mutant: no admissionStale probe (sanity check)
  ExemptErrorStall   \* treat a goal idled by a terminal stream error as intended

VARIABLES
  gid, gst, used, wrapped, ack, nextId, igen,   \* goal.json (+ identity/pause/terminal generation)
  cand, nextObj,                                \* pending continuation candidate slot
  gd, gdCand, gdGen, dreqG, dreqH, dbusy, retry,\* IdleDispatcher + goal dispatch
  turn, turns, userQ, hbQ, pendRepl,            \* session
  arm, kick, recov,                             \* async follow-ups still to run
  hbOn, hbGen, hbFlight, archived, restarts, uacts,
  badCont, badHb, dupFire, fired, errStall      \* ghosts

goalVars == <<gid, gst, used, wrapped, ack, nextId, igen>>
dispVars == <<gd, gdCand, gdGen, dreqG, dreqH, dbusy, retry>>
sessVars == <<turn, turns, userQ, hbQ, pendRepl>>
followVars == <<arm, kick, recov>>
miscVars == <<hbOn, hbGen, hbFlight, archived, restarts, uacts>>
ghostVars == <<badCont, badHb, dupFire, fired, errStall>>
vars == <<goalVars, cand, nextObj, dispVars, sessVars, followVars, miscVars, ghostVars>>

NoCand == [g |-> 0, o |-> 0]
NoTurn == [o |-> "none", g |-> 0]
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
  /\ restarts = 0 /\ uacts = 0
  /\ badCont = FALSE /\ badHb = FALSE /\ dupFire = FALSE /\ fired = {} /\ errStall = FALSE

-----------------------------------------------------------------------------
(* Goal dispatch                                                           *)

GDispatch ==
  /\ dbusy = "none" /\ dreqG
  /\ dbusy' = "goal" /\ dreqG' = FALSE /\ gd' = "elig" /\ gdCand' = cand /\ gdGen' = igen
  /\ UNCHANGED <<goalVars, cand, nextObj, dreqH, retry, sessVars, followVars, miscVars, ghostVars>>

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
     ELSE IF gdCand.g # gid \/ ~(gst = "active" \/ (gst = "limited" /\ ~wrapped)) THEN
       \* stop + dropCandidate (goal_mismatch / goal_not_active / wrap-up already fired).
       /\ GDone /\ UNCHANGED retry
       /\ cand' = IF FixStaleDrop THEN (IF cand = gdCand THEN NoCand ELSE cand) ELSE NoCand
     ELSE IF ack THEN
       /\ GDone /\ UNCHANGED <<cand, retry>>   \* requires_ack: stop, keep candidate
     ELSE
       /\ gd' = "admit" /\ UNCHANGED <<dbusy, gdCand, cand, retry>>
  /\ UNCHANGED <<goalVars, nextObj, gdGen, dreqG, dreqH, sessVars, followVars, miscVars, ghostVars>>

GAdmit ==
  /\ gd = "admit"
  /\ LET stale == igen # gdGen \/ cand # gdCand IN
     IF stale /\ ~MutNoProbe THEN
       /\ GDone /\ UNCHANGED <<goalVars, cand, retry, sessVars, ghostVars>>
     ELSE IF Busy THEN
       /\ GDone /\ retry' = TRUE /\ UNCHANGED <<goalVars, cand, sessVars, ghostVars>>
     ELSE IF ~CanStart THEN
       /\ GDone /\ UNCHANGED <<goalVars, cand, retry, sessVars, ghostVars>>
     ELSE
       /\ GDone /\ UNCHANGED retry
       /\ turn' = [o |-> IF gst = "limited" THEN "wrap" ELSE "cont", g |-> gdCand.g]
       /\ turns' = turns + 1
       /\ wrapped' = (wrapped \/ gst = "limited")
       /\ cand' = IF cand = gdCand THEN NoCand ELSE cand
       /\ badCont' = (badCont \/ gdCand.g # gid \/ ~Resumable(gst))
       /\ dupFire' = (dupFire \/ gdCand.o \in fired)
       /\ fired' = fired \cup {gdCand.o}
       /\ errStall' = FALSE
       /\ UNCHANGED <<gid, gst, used, ack, nextId, igen, userQ, hbQ, pendRepl, badHb>>
  /\ UNCHANGED <<nextObj, gdGen, dreqG, dreqH, followVars, miscVars>>

Retry ==
  /\ retry /\ retry' = FALSE
  /\ dreqG' = (dreqG \/ cand # NoCand)
  /\ UNCHANGED <<goalVars, cand, nextObj, gd, gdCand, gdGen, dreqH, dbusy, sessVars,
                 followVars, miscVars, ghostVars>>

ArmStreamEnd ==
  /\ arm /\ arm' = FALSE
  /\ IF gid # 0 /\ Resumable(gst) THEN
       cand' = NewCand /\ nextObj' = nextObj + 1 /\ dreqG' = TRUE
     ELSE
       cand' = NoCand /\ UNCHANGED <<nextObj, dreqG>>
  /\ UNCHANGED <<goalVars, gd, gdCand, gdGen, dreqH, dbusy, retry, sessVars, kick, recov,
                 miscVars, ghostVars>>

KickoffArm ==
  /\ kick /\ kick' = FALSE
  /\ IF gst = "active" /\ cand.g # gid THEN
       cand' = NewCand /\ nextObj' = nextObj + 1 /\ dreqG' = TRUE
     ELSE IF gst = "active" THEN
       dreqG' = TRUE /\ UNCHANGED <<cand, nextObj>>
     ELSE UNCHANGED <<cand, nextObj, dreqG>>
  /\ UNCHANGED <<goalVars, gd, gdCand, gdGen, dreqH, dbusy, retry, sessVars, arm, recov,
                 miscVars, ghostVars>>

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
     /\ gid' = IF repl THEN nextId ELSE gid
     /\ gst' = IF repl THEN "active" ELSE st1
     /\ used' = IF repl THEN 0 ELSE used1
     /\ wrapped' = IF repl THEN FALSE ELSE wrapped
     /\ nextId' = IF repl THEN nextId + 1 ELSE nextId
     /\ igen' = IF repl THEN igen + 1 ELSE igen
     /\ kick' = (kick \/ repl)
     /\ pendRepl' = FALSE
     /\ IF userQ /\ CanStart THEN
          /\ turn' = [o |-> "user", g |-> gid'] /\ turns' = turns + 1
          /\ userQ' = FALSE /\ cand' = NoCand /\ arm' = FALSE
          /\ UNCHANGED <<hbQ, badHb, errStall>>
        ELSE IF hbQ /\ hbStale THEN
          \* (fix) the stale heartbeat is dropped and the turn ends normally.
          /\ turn' = NoTurn /\ hbQ' = FALSE /\ arm' = TRUE
          /\ UNCHANGED <<turns, userQ, cand, badHb, errStall>>
        ELSE IF hbQ /\ CanStart THEN
          /\ turn' = [o |-> "hb", g |-> gid'] /\ turns' = turns + 1
          /\ hbQ' = FALSE /\ arm' = FALSE
          /\ badHb' = (badHb \/ ~hbOn)
          /\ UNCHANGED <<userQ, cand, errStall>>
        ELSE
          /\ turn' = NoTurn /\ arm' = QueueEmpty
          /\ UNCHANGED <<turns, userQ, hbQ, cand, badHb, errStall>>
  /\ UNCHANGED <<ack, nextObj, dispVars, recov, miscVars, badCont, dupFire, fired>>

\* Terminal stream error: the accounting snapshot is restored and no continuation is requested
\* (AS handleStreamError); the queue is left for the next turn.
TurnError ==
  /\ Errors /\ Busy
  /\ turn' = NoTurn
  /\ errStall' = (gid # 0 /\ gst = "active")
  /\ UNCHANGED <<goalVars, cand, nextObj, dispVars, turns, userQ, hbQ, pendRepl, followVars,
                 miscVars, badCont, badHb, dupFire, fired>>

-----------------------------------------------------------------------------
(* User and model                                                          *)

UserStep == UserActs /\ uacts < MaxUser /\ uacts' = uacts + 1

UserSend ==
  /\ UserStep /\ (Busy \/ CanStart)
  /\ ack' = FALSE                               \* acknowledgeUser
  /\ cand' = NoCand                             \* takePendingContinuationCandidateForManualUserMessage
  /\ hbQ' = FALSE                               \* new input supersedes a queued heartbeat (WS 15389)
  /\ IF Busy THEN userQ' = TRUE /\ UNCHANGED <<turn, turns, errStall>>
     ELSE turn' = [o |-> "user", g |-> gid] /\ turns' = turns + 1 /\ errStall' = FALSE
                 /\ UNCHANGED userQ
  /\ UNCHANGED <<gid, gst, used, wrapped, nextId, igen, nextObj, dispVars, pendRepl, followVars,
                 hbOn, hbGen, hbFlight, archived, restarts, badCont, badHb, dupFire, fired>>

UserReplace ==
  /\ UserStep /\ nextId <= MaxGoals
  /\ IF Busy THEN
       \* Mid-stream replacement is a pending mutation applied at stream end.
       /\ pendRepl' = TRUE /\ UNCHANGED <<goalVars, kick>>
     ELSE
       /\ gid' = nextId /\ nextId' = nextId + 1 /\ gst' = "active" /\ used' = 0
       /\ wrapped' = FALSE /\ igen' = igen + 1 /\ kick' = TRUE
       /\ UNCHANGED <<ack, pendRepl>>
  /\ UNCHANGED <<cand, nextObj, dispVars, turn, turns, userQ, hbQ, arm, recov,
                 hbOn, hbGen, hbFlight, archived, restarts, ghostVars>>

UserPause ==
  /\ UserStep /\ gst = "active"
  /\ gst' = "paused" /\ igen' = igen + 1 /\ cand' = NoCand
  /\ UNCHANGED <<gid, used, wrapped, ack, nextId, nextObj, dispVars, sessVars, followVars,
                 hbOn, hbGen, hbFlight, archived, restarts, ghostVars>>

UserResume ==
  /\ UserStep /\ gst = "paused"
  /\ gst' = "active" /\ igen' = igen + 1 /\ kick' = TRUE
  /\ UNCHANGED <<gid, used, wrapped, ack, nextId, cand, nextObj, dispVars, sessVars, arm, recov,
                 hbOn, hbGen, hbFlight, archived, restarts, ghostVars>>

UserClear ==
  /\ UserStep /\ gid # 0 /\ ~Busy
  /\ gid' = 0 /\ gst' = "none" /\ used' = 0 /\ igen' = igen + 1 /\ cand' = NoCand
  /\ UNCHANGED <<wrapped, ack, nextId, nextObj, dispVars, sessVars, followVars,
                 hbOn, hbGen, hbFlight, archived, restarts, ghostVars>>

ModelCompletes ==
  /\ ModelComplete /\ Busy /\ Resumable(gst)
  /\ gst' = "complete" /\ igen' = igen + 1
  /\ UNCHANGED <<gid, used, wrapped, ack, nextId, cand, nextObj, dispVars, sessVars, followVars,
                 miscVars, ghostVars>>

-----------------------------------------------------------------------------
(* Heartbeats                                                              *)

HbFire ==
  /\ HbMode # "off" /\ hbOn /\ ~archived /\ ~dreqH /\ hbFlight = "idle"
  /\ dreqH' = TRUE
  /\ UNCHANGED <<goalVars, cand, nextObj, gd, gdCand, gdGen, dreqG, dbusy, retry, sessVars,
                 followVars, miscVars, ghostVars>>

\* Goal priority: the dispatcher serves a pending goal request first.
HbDispatch ==
  /\ dbusy = "none" /\ dreqH /\ ~dreqG
  /\ dreqH' = FALSE
  /\ IF hbOn /\ ~archived /\ ~(HbMode = "skip" /\ Busy) THEN
       dbusy' = "hb" /\ hbFlight' = "send"
     ELSE UNCHANGED <<dbusy, hbFlight>>
  /\ UNCHANGED <<goalVars, cand, nextObj, gd, gdCand, gdGen, dreqG, retry, sessVars, followVars,
                 hbOn, hbGen, archived, restarts, uacts, ghostVars>>

HbSend ==
  /\ hbFlight = "send"
  /\ hbFlight' = "idle" /\ dbusy' = "none"
  /\ IF FixHbSendRecheck /\ (~hbOn \/ archived) THEN
       UNCHANGED <<turn, turns, hbQ, badHb, errStall>>
     ELSE IF Busy THEN
       \* skip mode throws; queue modes queue unless any message is queued.
       /\ hbQ' = (hbQ \/ (HbMode = "queue" /\ ~userQ))
       /\ UNCHANGED <<turn, turns, badHb, errStall>>
     ELSE IF CanStart THEN
       /\ turn' = [o |-> "hb", g |-> gid] /\ turns' = turns + 1
       /\ badHb' = (badHb \/ ~hbOn) /\ errStall' = FALSE
       /\ UNCHANGED hbQ
     ELSE UNCHANGED <<turn, turns, hbQ, badHb, errStall>>
  /\ UNCHANGED <<goalVars, cand, nextObj, gd, gdCand, gdGen, dreqG, dreqH, retry, userQ,
                 pendRepl, followVars, hbOn, hbGen, archived, restarts, uacts,
                 badCont, dupFire, fired>>

\* The user or the model (heartbeat tool) enables, disables or unsets the heartbeat.
HbToggle ==
  /\ HbMode # "off" /\ hbGen < MaxHbGen
  /\ hbOn' = ~hbOn /\ hbGen' = hbGen + 1
  /\ UNCHANGED <<goalVars, cand, nextObj, dispVars, sessVars, followVars, hbFlight, archived,
                 restarts, uacts, ghostVars>>

-----------------------------------------------------------------------------
(* Archive and restart                                                     *)

\* Archive interrupts the stream and holds turn admission (queued entries included).
Archive ==
  /\ ArchiveOn /\ ~archived
  /\ archived' = TRUE /\ turn' = NoTurn
  /\ UNCHANGED <<goalVars, cand, nextObj, dispVars, turns, userQ, hbQ, pendRepl, followVars,
                 hbOn, hbGen, hbFlight, restarts, uacts, ghostVars>>

Restart ==
  /\ restarts < MaxRestarts /\ restarts' = restarts + 1
  \* A crash-recovered partial of a goal-active workspace requires user acknowledgment.
  /\ ack' = (ack \/ (Busy /\ Resumable(gst)))
  /\ cand' = NoCand /\ gd' = "idle" /\ gdCand' = NoCand /\ dreqG' = FALSE /\ dreqH' = FALSE
  /\ dbusy' = "none" /\ retry' = FALSE
  /\ turn' = NoTurn /\ userQ' = FALSE /\ hbQ' = FALSE /\ pendRepl' = FALSE
  /\ arm' = FALSE /\ kick' = FALSE /\ recov' = TRUE /\ hbFlight' = "idle"
  /\ errStall' = FALSE
  /\ UNCHANGED <<gid, gst, used, wrapped, nextId, igen, nextObj, gdGen, turns, hbOn, hbGen,
                 archived, uacts, badCont, badHb, dupFire, fired>>

Recover ==
  /\ recov /\ recov' = FALSE
  /\ IF ~ack /\ (gst = "active" \/ (gst = "limited" /\ ~wrapped)) THEN
       cand' = NewCand /\ nextObj' = nextObj + 1 /\ dreqG' = TRUE
     ELSE UNCHANGED <<cand, nextObj, dreqG>>
  /\ UNCHANGED <<goalVars, gd, gdCand, gdGen, dreqH, dbusy, retry, sessVars, arm, kick,
                 miscVars, ghostVars>>

Next ==
  \/ GDispatch \/ GEligFinish \/ GAdmit \/ Retry \/ ArmStreamEnd \/ KickoffArm
  \/ TurnEnd \/ TurnError
  \/ UserSend \/ UserReplace \/ UserPause \/ UserResume \/ UserClear \/ ModelCompletes
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

\* Nothing internal is left to run: no turn, no dispatch request or check, no timer, no
\* queued message, no follow-up. States at the turn bound, archived workspaces and workspaces
\* whose enabled heartbeat would still wake them are excluded.
Quiescent ==
  /\ ~Busy /\ gd = "idle" /\ dbusy = "none" /\ ~dreqG /\ ~dreqH /\ ~retry
  /\ ~arm /\ ~kick /\ ~recov /\ hbFlight = "idle" /\ QueueEmpty
  /\ turns < MaxTurns /\ ~archived /\ ~(HbMode # "off" /\ hbOn)

\* An active goal that does not wait for the user is never left with nothing able to drive it.
NoStrandedGoal == (Quiescent /\ gst = "active" /\ ~ack) => (ExemptErrorStall /\ errStall)

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
