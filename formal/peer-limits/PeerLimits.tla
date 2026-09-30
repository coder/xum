---------------------------- MODULE PeerLimits ----------------------------
(***************************************************************************)
(* Peer-message admission limits for ONE target workspace T, at commit    *)
(* 520ef794aa:                                                             *)
(*   src/node/services/agentPeerMessageBroker.ts    checkPeerAdmission,    *)
(*       recordPeerAttempt / recordPeerDelivery, sweep                     *)
(*   src/node/services/taskService.ts                                      *)
(*       sendFamilyTreeMessage (task_message_parent / task_message_sibling)*)
(*       sendTreeMessage relation "peer" (task_send_message to siblings,   *)
(*         ancestors, unrelated roots; idle-root wakes; busy-target queue) *)
(*       parkPeerSend / flushParkedPeerSends (delegated-turn waits, #4997) *)
(*   src/constants/agentMessaging.ts                limits                 *)
(*                                                                         *)
(* Granularity: one action per await-free segment; synchronous code that   *)
(* runs between two awaits is one action. Each action names its lines.     *)
(*                                                                         *)
(* Scaled limits: the model keeps the ratios of the real constants         *)
(* (target = 2 x pair, dedupe window = 2 x rate window), not the values.   *)
(*                                                                         *)
(* Fix flags: with SharedLock, ChargeAtAdmission and ShiftUnderLock all    *)
(* TRUE the model matches the fixed code (withPeerAdmissionLock, the peer  *)
(* route's recordPeerAttempt at admission, the retry's parked-list removal *)
(* under that lock). All FALSE is the code at 520ef794aa; line numbers     *)
(* below refer to that commit.                                             *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
  Senders, Texts,
  Ops,            \* concurrent send operations (each one tool call)
  Backends,       \* {1}, or {1,2} for two backends on one root
  W,              \* PEER_MESSAGE_RATE_WINDOW_MS, in ticks
  D,              \* PEER_MESSAGE_DEDUPE_WINDOW_MS, in ticks
  PairMax,        \* PEER_MESSAGE_RATE_LIMIT_MAX
  TargetMax,      \* PEER_MESSAGE_TARGET_RATE_LIMIT_MAX
  Cap,            \* MAX_QUEUED_PEER_MESSAGES_PER_TARGET
  MaxTime,
  Routes,         \* subset of {"peer", "family"}
  FailAfterRows,  \* sendMessage may persist the payload row and still fail
  CanRestart,     \* a backend restart clears its in-memory state
  Deleg,          \* the target may run delegated turns other senders wait for
  \* Mutations (all FALSE for the faithful model):
  NoPairCheck, NoDedupeCheck, NoCapCheck,  \* sanity: drop one broker check
  \* Fixes (all TRUE for the fixed code, all FALSE for 520ef794aa):
  SharedLock,        \* B1: both routes hold one per-target admission lock
  ChargeAtAdmission, \* B2: the peer route charges right after its check
  ShiftUnderLock     \* B3: a retry leaves the parked list under that lock

NoTime == 1000    \* "never" for the dedupe map (MaxTime + D < NoTime)

VARIABLES
  now,
  pairT,    \* [b][s] -> Seq of charge times (peerMessageSendTimesByPair)
  tgtT,     \* [b] -> Seq of charge times (peerMessageSendTimesByTarget)
  dd,       \* [b][s][x] -> last delivery time (peerMessageDedupeTimes)
  q,        \* [b] -> queued peer/family entries in T's MessageQueue
  parked,   \* [b] -> Seq of ops waiting for a delegated turn
  flushing, \* [b] -> op being retried by flushParkedPeerSends, or 0
  deleg,    \* [b] -> T runs another workspace's delegated turn
  busy,     \* [b] -> T is streaming (sends queue)
  evLock,   \* [b] -> holder of workspaceEventLocks(T), or 0
  dlLock,   \* [b] -> holder of broker.withDeliveryLock(T), or 0
  pc, route, snd, txt, be, retry, charged,
  deliveries \* set of [o, s, x, t]: payload rows that reached T

vars == <<now, pairT, tgtT, dd, q, parked, flushing, deleg, busy, evLock, dlLock,
          pc, route, snd, txt, be, retry, charged, deliveries>>
opv == <<pc, route, snd, txt, be, retry, charged>>
brk == <<pairT, tgtT, dd>>

Recent(seq, win) == SelectSeq(seq, LAMBDA t : t + win > now)
\* A dedupe entry still inside its window (broker.ts:80).
Armed(t) == t # NoTime /\ now < t + D
Queued(b) == q[b] + Len(parked[b])   \* taskService.ts:4582-4584

(* agentPeerMessageBroker.ts:50-95 admission verdict for sender s, text x. *)
Verdict(b, s, x) ==
  IF ~NoPairCheck /\ Len(Recent(pairT[b][s], W)) >= PairMax THEN "rate"      \* :60-68
  ELSE IF Len(Recent(tgtT[b], W)) >= TargetMax THEN "rate"                   \* :69-77
  ELSE IF ~NoDedupeCheck /\ Armed(dd[b][s][x]) THEN "dup"                    \* :79-85
  ELSE IF ~NoCapCheck /\ Queued(b) >= Cap THEN "cap"                          \* :87-92
  ELSE "ok"

(* :178-194 sweep, run by every check. *)
Sweep(b) ==
  /\ pairT' = [pairT EXCEPT ![b] = [s \in Senders |-> Recent(@[s], W)]]
  /\ tgtT' = [tgtT EXCEPT ![b] = Recent(@, W)]
  /\ dd' = [dd EXCEPT ![b] = [s \in Senders |-> [x \in Texts |->
             IF Armed(@[s][x]) THEN @[s][x] ELSE NoTime]]]

(* :103-112 recordPeerAttempt (after a sweep in the same action, or alone). *)
ChargeAfterSweep(b, s) ==
  /\ pairT' = [pairT EXCEPT ![b] = [t \in Senders |->
                IF t = s THEN Append(Recent(@[t], W), now) ELSE Recent(@[t], W)]]
  /\ tgtT' = [tgtT EXCEPT ![b] = Append(Recent(@, W), now)]
Charge(b, s) ==
  /\ pairT' = [pairT EXCEPT ![b][s] = Append(@, now)]
  /\ tgtT' = [tgtT EXCEPT ![b] = Append(@, now)]
(* :115-118 recordPeerDelivery. *)
ArmDedupe(b, s, x) == dd' = [dd EXCEPT ![b][s][x] = now]

Init ==
  /\ now = 0
  /\ pairT = [b \in Backends |-> [s \in Senders |-> <<>>]]
  /\ tgtT = [b \in Backends |-> <<>>]
  /\ dd = [b \in Backends |-> [s \in Senders |-> [x \in Texts |-> NoTime]]]
  /\ q = [b \in Backends |-> 0]
  /\ parked = [b \in Backends |-> <<>>]
  /\ flushing = [b \in Backends |-> 0]
  /\ deleg = [b \in Backends |-> FALSE]
  /\ busy = [b \in Backends |-> FALSE]
  /\ evLock = [b \in Backends |-> 0]
  /\ dlLock = [b \in Backends |-> 0]
  /\ pc = [o \in Ops |-> "idle"]
  /\ route = [o \in Ops |-> "peer"]
  /\ snd = [o \in Ops |-> CHOOSE s \in Senders : TRUE]
  /\ txt = [o \in Ops |-> CHOOSE x \in Texts : TRUE]
  /\ be = [o \in Ops |-> CHOOSE b \in Backends : TRUE]
  /\ retry = [o \in Ops |-> FALSE]
  /\ charged = [o \in Ops |-> NoTime]
  /\ deliveries = {}

Go(o, to) == pc' = [pc EXCEPT ![o] = to]
\* The time a delivery is accounted at: its charge, else when its row landed.
\* ok: the sender is told the send succeeded (FALSE: rows landed, Err returned).
Deliver(o, ok) ==
  deliveries' = deliveries \cup
    {[o |-> o, s |-> snd[o], x |-> txt[o], ok |-> ok,
      t |-> IF charged[o] # NoTime THEN charged[o] ELSE now]}
DeliveryEffect(b, o) ==   \* the rows land; a busy target queues a sealed entry
  /\ Deliver(o, TRUE)
  /\ q' = [q EXCEPT ![b] = IF busy[b] THEN @ + 1 ELSE @]

(* A tool call starts: task_send_message.ts:40, task_message_parent.ts:25, *)
(* task_message_sibling.ts:26 (message trimmed at taskService.ts:9535).    *)
Start(o) ==
  /\ pc[o] = "idle"
  /\ \E r \in Routes, s \in Senders, x \in Texts, b \in Backends :
       /\ route' = [route EXCEPT ![o] = r]
       /\ snd' = [snd EXCEPT ![o] = s]
       /\ txt' = [txt EXCEPT ![o] = x]
       /\ be' = [be EXCEPT ![o] = b]
       /\ Go(o, IF r = "peer" THEN "plock" ELSE "flock")
  /\ UNCHANGED <<now, brk, q, parked, flushing, deleg, busy, evLock, dlLock, retry,
                 charged, deliveries>>

---------------------------------------------------------------------------
(* Peer route: sendTreeMessage relation "peer".                            *)

\* taskService.ts:9574 workspaceEventLocks.withLock(targetId) (fixed:
\* withPeerAdmissionLock). ShiftUnderLock: a retry removes itself from the
\* head of the parked list here, not in FlushShift.
PLock(o) ==
  LET b == be[o] IN
  /\ pc[o] = "plock" /\ evLock[b] = 0
  /\ evLock' = [evLock EXCEPT ![b] = o]
  /\ Go(o, IF retry[o] THEN "psend" ELSE "pcheck")   \* :9866-9868 retry skips
  /\ IF ShiftUnderLock /\ retry[o] /\ Len(parked[b]) > 0 /\ Head(parked[b]) = o
       THEN parked' = [parked EXCEPT ![b] = Tail(@)]
       ELSE UNCHANGED parked
  /\ UNCHANGED <<now, brk, q, flushing, deleg, busy, dlLock, route, snd, txt, be,
                 retry, charged, deliveries>>

Release(o, lockVar) == lockVar' = [lockVar EXCEPT ![be[o]] = 0]

\* taskService.ts:9866-9872 checkPeerAdmission (first attempts only).
\* ChargeAtAdmission: charge in the same await-free segment, like FCheck.
PCheck(o) ==
  LET b == be[o] IN
  /\ pc[o] = "pcheck"
  /\ IF Verdict(b, snd[o], txt[o]) = "ok"
       THEN /\ IF ChargeAtAdmission
                 THEN /\ ChargeAfterSweep(b, snd[o])
                      /\ dd' = [dd EXCEPT ![b] = [s \in Senders |-> [x \in Texts |->
                                 IF Armed(@[s][x]) THEN @[s][x] ELSE NoTime]]]
                      /\ charged' = [charged EXCEPT ![o] = now]
                 ELSE Sweep(b) /\ UNCHANGED charged
            /\ Go(o, "pdecide") /\ UNCHANGED evLock
       ELSE Sweep(b) /\ Go(o, "done") /\ Release(o, evLock) /\ UNCHANGED charged
  /\ UNCHANGED <<now, q, parked, flushing, deleg, busy, dlLock, route, snd, txt, be, retry,
                 deliveries>>

\* taskService.ts:10127-10149 after the awaits at :9923 and :9939: park
\* behind a delegated turn (or behind parked messages still draining) and
\* charge now (recordPeerSend :10131), or go on to sendMessage.
PDecide(o) ==
  LET b == be[o] IN
  /\ pc[o] = "pdecide"
  /\ IF deleg[b] \/ Len(parked[b]) > 0 \/ flushing[b] # 0
       THEN /\ parked' = [parked EXCEPT ![b] = Append(@, o)]
            /\ ArmDedupe(b, snd[o], txt[o])
            /\ IF ChargeAtAdmission
                 THEN UNCHANGED <<pairT, tgtT, charged>>
                 ELSE Charge(b, snd[o]) /\ charged' = [charged EXCEPT ![o] = now]
            /\ Release(o, evLock) /\ Go(o, "parked")
       ELSE /\ Go(o, "psend")
            /\ UNCHANGED <<parked, brk, charged, evLock>>
  /\ UNCHANGED <<now, q, flushing, deleg, busy, dlLock, route, snd, txt, be, retry,
                 deliveries>>

\* taskService.ts:10160 workspaceService.sendMessage: the rows land (idle
\* target: accepted; busy: sealed queue entry), or it fails before any row,
\* or (FailAfterRows) it persists the payload row and still reports failure.
\* A retry that meets a new delegated turn is dropped (:9723-9729).
PSend(o) ==
  LET b == be[o] IN
  /\ pc[o] = "psend"
  /\ IF retry[o] /\ deleg[b]
       THEN Go(o, "pfail") /\ UNCHANGED <<q, deliveries>>
       ELSE \/ DeliveryEffect(b, o) /\ Go(o, "pok")
            \/ Go(o, "pfail") /\ UNCHANGED <<q, deliveries>>
            \/ FailAfterRows /\ Deliver(o, FALSE) /\ Go(o, "pfail") /\ UNCHANGED q
  /\ UNCHANGED <<now, brk, parked, flushing, deleg, busy, evLock, dlLock, route, snd, txt,
                 be, retry, charged>>

\* taskService.ts:10187-10207: success charges (unless ChargeAtAdmission
\* already did) + arms dedupe (first attempts only); failure returns Err
\* without charging. Releases the event lock.
PReturn(o) ==
  LET b == be[o] IN
  /\ pc[o] \in {"pok", "pfail"}
  /\ IF ~retry[o] /\ pc[o] = "pok"
       THEN /\ ArmDedupe(b, snd[o], txt[o])
            /\ IF ChargeAtAdmission
                 THEN UNCHANGED <<pairT, tgtT, charged>>
                 ELSE Charge(b, snd[o]) /\ charged' = [charged EXCEPT ![o] = now]
       ELSE UNCHANGED <<brk, charged>>
  \* A charge recorded after the row landed re-times that delivery.
  /\ deliveries' = {IF d.o = o /\ charged'[o] # NoTime THEN [d EXCEPT !.t = charged'[o]] ELSE d
                     : d \in deliveries}
  /\ Release(o, evLock)
  /\ flushing' = [flushing EXCEPT ![b] = IF @ = o THEN 0 ELSE @]
  /\ Go(o, "done")
  /\ UNCHANGED <<now, q, parked, deleg, busy, dlLock, route, snd, txt, be, retry>>

\* taskService.ts:2527-2561 flushParkedPeerSends: once no delegated turn is
\* live, shift the head (:2551) OUTSIDE the event lock and retry the whole
\* peer path (:2561), one message at a time (parkedPeerSendFlushLocks).
\* ShiftUnderLock: the head stays parked until its retry holds the lock.
FlushShift(b) ==
  /\ ~deleg[b] /\ flushing[b] = 0 /\ Len(parked[b]) > 0
  /\ LET o == Head(parked[b]) IN
       /\ parked' = [parked EXCEPT ![b] = IF ShiftUnderLock THEN @ ELSE Tail(@)]
       /\ flushing' = [flushing EXCEPT ![b] = o]
       /\ retry' = [retry EXCEPT ![o] = TRUE]
       /\ Go(o, "plock")
  /\ UNCHANGED <<now, brk, q, deleg, busy, evLock, dlLock, route, snd, txt, be, charged,
                 deliveries>>

---------------------------------------------------------------------------
(* Family route: sendFamilyTreeMessage.                                    *)

\* taskService.ts:9414 broker.withDeliveryLock(target) (a DIFFERENT mutex
\* from the peer route's :9574, unless SharedLock: both hold one lock).
FLock(o) ==
  LET b == be[o] IN
  /\ pc[o] = "flock"
  /\ IF SharedLock
       THEN evLock[b] = 0 /\ evLock' = [evLock EXCEPT ![b] = o] /\ UNCHANGED dlLock
       ELSE dlLock[b] = 0 /\ dlLock' = [dlLock EXCEPT ![b] = o] /\ UNCHANGED evLock
  /\ Go(o, "fcheck")
  /\ UNCHANGED <<now, brk, q, parked, flushing, deleg, busy, route, snd, txt, be, retry,
                 charged, deliveries>>

FRelease(o) ==
  IF SharedLock THEN Release(o, evLock) /\ UNCHANGED dlLock
  ELSE Release(o, dlLock) /\ UNCHANGED evLock

\* taskService.ts:9420-9437 check, then charge before dispatch (no await).
FCheck(o) ==
  LET b == be[o] IN
  /\ pc[o] = "fcheck"
  /\ IF Verdict(b, snd[o], txt[o]) = "ok"
       THEN /\ ChargeAfterSweep(b, snd[o])
            /\ dd' = [dd EXCEPT ![b] = [s \in Senders |-> [x \in Texts |->
                       IF Armed(@[s][x]) THEN @[s][x] ELSE NoTime]]]
            /\ charged' = [charged EXCEPT ![o] = now]
            /\ Go(o, "fsend") /\ UNCHANGED <<evLock, dlLock>>
       ELSE Sweep(b) /\ Go(o, "done") /\ FRelease(o) /\ UNCHANGED charged
  /\ UNCHANGED <<now, q, parked, flushing, deleg, busy, route, snd, txt, be, retry,
                 deliveries>>

\* taskService.ts:9448 wakeParentWorkspaceWithSyntheticMessage / :9476
\* dispatchTrustedDescendantMessage: rows land, or failure before/after rows.
FSend(o) ==
  LET b == be[o] IN
  /\ pc[o] = "fsend"
  /\ \/ DeliveryEffect(b, o) /\ Go(o, "fok")
     \/ Go(o, "ffail") /\ UNCHANGED <<q, deliveries>>
     \/ FailAfterRows /\ Deliver(o, FALSE) /\ Go(o, "ffail") /\ UNCHANGED q
  /\ UNCHANGED <<now, brk, parked, flushing, deleg, busy, evLock, dlLock, route, snd, txt,
                 be, retry, charged>>

\* taskService.ts:9462-9471 / :9487-9493 success arms dedupe; release lock.
FReturn(o) ==
  LET b == be[o] IN
  /\ pc[o] \in {"fok", "ffail"}
  /\ IF pc[o] = "fok" THEN ArmDedupe(b, snd[o], txt[o]) ELSE UNCHANGED dd
  /\ FRelease(o) /\ Go(o, "done")
  /\ UNCHANGED <<now, pairT, tgtT, q, parked, flushing, deleg, busy, route, snd, txt, be,
                 retry, charged, deliveries>>

---------------------------------------------------------------------------
(* Environment. *)

Tick == now < MaxTime /\ now' = now + 1 /\ UNCHANGED <<brk, q, parked, flushing, deleg,
          busy, evLock, dlLock, opv, deliveries>>
SetBusy(b) == busy' = [busy EXCEPT ![b] = ~@] /\ UNCHANGED <<now, brk, q, parked, flushing,
          deleg, evLock, dlLock, opv, deliveries>>
\* The target's queue dispatches one entry (MessageQueue drain).
Dispatch(b) == q[b] > 0 /\ q' = [q EXCEPT ![b] = @ - 1] /\ UNCHANGED <<now, brk, parked,
          flushing, deleg, busy, evLock, dlLock, opv, deliveries>>
\* Another workspace's delegated turn registers / releases (onWorkspaceTurnRegistered).
SetDeleg(b) == Deleg /\ deleg' = [deleg EXCEPT ![b] = ~@] /\ UNCHANGED <<now, brk, q, parked,
          flushing, busy, evLock, dlLock, opv, deliveries>>
\* Backend restart: all in-memory state of backend b is gone (documented,
\* agentMessaging.ts:6-7); its in-flight tool calls die with it.
Restart(b) ==
  /\ CanRestart
  /\ pairT' = [pairT EXCEPT ![b] = [s \in Senders |-> <<>>]]
  /\ tgtT' = [tgtT EXCEPT ![b] = <<>>]
  /\ dd' = [dd EXCEPT ![b] = [s \in Senders |-> [x \in Texts |-> NoTime]]]
  /\ q' = [q EXCEPT ![b] = 0]
  /\ parked' = [parked EXCEPT ![b] = <<>>]
  /\ flushing' = [flushing EXCEPT ![b] = 0]
  /\ deleg' = [deleg EXCEPT ![b] = FALSE]
  /\ evLock' = [evLock EXCEPT ![b] = 0]
  /\ dlLock' = [dlLock EXCEPT ![b] = 0]
  /\ pc' = [o \in Ops |-> IF be[o] = b /\ pc[o] # "idle" THEN "done" ELSE pc[o]]
  /\ UNCHANGED <<now, busy, route, snd, txt, be, retry, charged, deliveries>>

Next ==
  \/ \E o \in Ops : Start(o) \/ PLock(o) \/ PCheck(o) \/ PDecide(o) \/ PSend(o)
                    \/ PReturn(o) \/ FLock(o) \/ FCheck(o) \/ FSend(o) \/ FReturn(o)
  \/ \E b \in Backends : FlushShift(b) \/ SetBusy(b) \/ Dispatch(b) \/ SetDeleg(b)
                         \/ Restart(b)
  \/ Tick

Spec == Init /\ [][Next]_vars

---------------------------------------------------------------------------
(* Properties. Each is stated over the rows that actually reached T, timed *)
(* by their charge (or landing time when never charged).                   *)

InWin(t, e) == t < e + W /\ e <= t   \* charge time e lies in window (t-W, t]

\* PEER_MESSAGE_RATE_LIMIT_MAX per sender->target pair, any sliding window.
PairRate == \A s \in Senders, t \in 0..MaxTime :
  Cardinality({d \in deliveries : d.s = s /\ InWin(t, d.t)}) <= PairMax
\* PEER_MESSAGE_TARGET_RATE_LIMIT_MAX per target across senders.
TargetRate == \A t \in 0..MaxTime :
  Cardinality({d \in deliveries : InWin(t, d.t)}) <= TargetMax
\* Identical (sender, target, text) within the dedupe window lands once. Only
\* sends reported as successful count: resending a text after a reported
\* failure is a legitimate retry (rate limits still bound it).
Dedupe == \A d1, d2 \in deliveries :
  (d1.o # d2.o /\ d1.s = d2.s /\ d1.x = d2.x /\ d1.ok /\ d2.ok) =>
    (d1.t >= d2.t + D \/ d2.t >= d1.t + D)
\* MAX_QUEUED_PEER_MESSAGES_PER_TARGET: queued + parked never exceed the cap.
QueueCap == \A b \in Backends : Queued(b) <= Cap
\* An admission refusal (op done without a charge) leaves no row behind,
\* unless the row landed on a delivery path that reported failure.
NoHalfEnqueue == \A o \in Ops :
  (pc[o] = "done" /\ charged[o] = NoTime /\ ~FailAfterRows) =>
    ~\E d \in deliveries : d.o = o
\* Broker lists stay bounded by their limits (swept on every check).
StateBounded == \A b \in Backends :
  /\ Len(tgtT[b]) <= TargetMax
  /\ \A s \in Senders : Len(pairT[b][s]) <= PairMax

TypeOK == /\ now \in 0..MaxTime
          /\ \A b \in Backends : q[b] \in 0..(Cardinality(Ops))
=============================================================================
