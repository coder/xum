--------------------------- MODULE ComposerDrafts ---------------------------
(***************************************************************************)
(* Where the text a user typed lives, for ONE workspace composer, at      *)
(* commit f30a1945a6:                                                      *)
(*   src/browser/stores/DraftStore.ts   setText/drain (debounced backend   *)
(*       write, one in flight, LWW), applyServerState (skips dirty fields) *)
(*   src/browser/features/ChatInput/index.tsx  send: optimistic            *)
(*       removeSentText (2687), sendMessage (2704), restore on failure     *)
(*       setDraft(preSendDraft) (2717, 2787)                               *)
(*   src/browser/features/ChatInput/useCreationWorkspace.ts  creation      *)
(*       /goal: clearPendingDraft (767) before the command, no transfer on *)
(*       a non-consumed command (829)                                      *)
(*   src/node/services/draftService.ts  update (read-merge-write, no CAS), *)
(*       creation-draft GC by project ownership                            *)
(*   src/node/services/agentSession.ts  held inputs (retained unsent       *)
(*       input): dequeue refusal / Stop hold queued input; claim, Retry    *)
(*       (workspaceService.sendHeldInput), Discard refused while claimed;  *)
(*       refuseBeforeAcceptance keeps rows when rollback fails (4261)      *)
(*                                                                         *)
(* Text is a set of tokens, one per thing the user typed (order is         *)
(* irrelevant to loss). Window A is modelled in full; window B (another    *)
(* window or client) writes the backend draft on top of what it last saw,  *)
(* and A receives the change event. A token is "safe" when it is in A's    *)
(* composer, the backend draft, the transcript, the send queue, the held   *)
(* list, an in-flight request or command, a goal, or the user chose to     *)
(* drop it (discard, queue clear); typing lost in the debounce window of a *)
(* hard quit is accepted by design (DraftStore.ts:52) and tracked apart.   *)
(*                                                                         *)
(* Fix flags (all off = the code at f30a1945a6):                           *)
(*   FixMergeRestore      a failed send merges its text back instead of    *)
(*                        replacing the composer                           *)
(*   FixConditionalWrite  a draft write is refused when the draft changed  *)
(*                        since the composer last saw it (#5226 item 4);   *)
(*                        the composer merges and writes again             *)
(*   FixNoRestoreAccepted a send the backend accepted is never restored    *)
(*                        (needs an idempotency key or acceptance read)    *)
(*   FixKeepUntilAccepted the backend draft keeps a send's text until the  *)
(*                        backend accepts it, and the accept removes it    *)
(*   FixCreationTransfer  the creation draft is deleted only once the      *)
(*                        command consumed its input; a non-consumed       *)
(*                        command moves it to the new workspace's draft    *)
(* MutLaxGc (mutant): the creation-draft GC treats an unreadable list as   *)
(* empty, like the snapshot fallback, instead of aborting.                 *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
  Msgs,            \* tokens the user may type, each at most once
  TwoWindows,      \* window B edits the same draft
  Simultaneous,    \* B may edit while A has unsaved edits (declined: last writer wins)
  WithQueue,       \* queued sends, dequeue refusal, Stop, queue clear, held Retry/Discard
  WithCreation,    \* the composer is a creation composer; /goal creates the workspace
  WithQuit,        \* the app quits or crashes (renderer and backend)
  WithGc,          \* creation-draft GC sweeps, whose list read may fail
  RollbackFail,    \* a held Retry's refusal cannot roll back its durable user row
  FixMergeRestore, FixConditionalWrite, FixNoRestoreAccepted, FixKeepUntilAccepted,
  FixCreationTransfer,
  MutLaxGc

ASSUME Msgs # {} /\ IsFiniteSet(Msgs)

VARIABLES
  typed,      \* ghost: tokens typed so far
  comp,       \* window A's composer text
  dirty,      \* A has edits the backend has not confirmed
  draft,      \* backend draft of A's composer scope
  base,       \* the backend draft as A last saw it (written or received)
  evt,        \* a change event from B is on its way to A
  phase,      \* A's send: none | req (request in flight) | acc (backend accepted, reply pending)
  pre,        \* preSendDraft captured by the in-flight send
  sending,    \* tokens the in-flight send took
  flushedMid, \* a draft write happened while the send was in flight
  sent,       \* times each token reached the transcript
  queue,      \* accepted, not yet dispatched (in-memory)
  held,       \* retained unsent input (in-memory)
  claimed,    \* held tokens claimed by an in-flight Retry
  dropped,    \* ghost: tokens the user chose to drop (Discard, queue clear)
  lostOk,     \* ghost: typing lost in the accepted debounce window of a hard quit
  crea,       \* creation flow: none | cmd (command running) | done
  pend,       \* the creation command's input (renderer memory)
  goal,       \* goal objectives (a durable home for /goal input)
  wsDraft,    \* draft of the workspace created by the creation flow
  listed,     \* the creation draft is in drafts/list.json
  quits

vars == <<typed, comp, dirty, draft, base, evt, phase, pre, sending, flushedMid, sent, queue, held, claimed,
          dropped, lostOk, crea, pend, goal, wsDraft, listed, quits>>

TypeOK ==
  /\ typed \subseteq Msgs /\ comp \subseteq Msgs /\ draft \subseteq Msgs /\ base \subseteq Msgs
  /\ dirty \in BOOLEAN /\ evt \in BOOLEAN
  /\ phase \in {"none", "req", "acc"} /\ pre \subseteq Msgs /\ sending \subseteq Msgs
  /\ flushedMid \in BOOLEAN
  /\ sent \in [Msgs -> 0..2]
  /\ queue \subseteq Msgs /\ held \subseteq Msgs /\ claimed \subseteq held
  /\ dropped \subseteq Msgs /\ lostOk \subseteq Msgs
  /\ crea \in {"none", "cmd", "done"} /\ pend \subseteq Msgs /\ goal \subseteq Msgs
  /\ wsDraft \subseteq Msgs /\ listed \in BOOLEAN /\ quits \in 0..1

Init ==
  /\ typed = {} /\ comp = {} /\ dirty = FALSE /\ draft = {} /\ base = {} /\ evt = FALSE
  /\ phase = "none" /\ pre = {} /\ sending = {} /\ flushedMid = FALSE
  /\ sent = [m \in Msgs |-> 0] /\ queue = {} /\ held = {} /\ claimed = {}
  /\ dropped = {} /\ lostOk = {}
  /\ crea = "none" /\ pend = {} /\ goal = {} /\ wsDraft = {} /\ listed = FALSE /\ quits = 0

\* Saturates at 2: NoDup only needs "more than once", and resend loops stay finite.
Inc(f, S) == [m \in Msgs |-> IF m \in S /\ f[m] < 2 THEN f[m] + 1 ELSE f[m]]
\* The composer can take input: no send in flight (its textarea is disabled, index.tsx:3169)
\* and no creation command running.
Idle == phase = "none" /\ crea # "cmd"
\* Without Simultaneous, nobody edits on top of a change the other side has not seen yet.
Quiet == Simultaneous \/ ~evt

-----------------------------------------------------------------------------
(* Window A: typing and the debounced backend write.                       *)

TypeA(m) ==
  /\ m \notin typed /\ Idle /\ Quiet /\ crea # "done"
  /\ typed' = typed \cup {m} /\ comp' = comp \cup {m} /\ dirty' = TRUE
  /\ UNCHANGED <<draft, base, evt, phase, pre, sending, flushedMid, sent, queue, held, claimed, dropped, lostOk,
                 crea, pend, goal, wsDraft, listed, quits>>

\* With FixKeepUntilAccepted the composer's write also carries the in-flight send's text, which
\* the composer does not show.
Hidden == IF FixKeepUntilAccepted /\ phase = "req" THEN sending ELSE {}
Full == comp \cup Hidden

\* drain(): one whole-field write; drafts.update has no revision check, so it overwrites.
\* With FixKeepUntilAccepted the write also keeps the text of a send not yet accepted.
Flush ==
  /\ dirty
  /\ IF FixConditionalWrite /\ evt
       \* The write is refused (the draft changed since this composer last saw it); the
       \* composer merges the newer draft in and writes again later.
       THEN /\ comp' = ((draft \ (base \ Full)) \cup (Full \ base)) \ Hidden  \* 3-way merge
            /\ base' = draft /\ evt' = FALSE
            /\ UNCHANGED <<draft, dirty, flushedMid>>
       ELSE /\ draft' = Full
            /\ base' = Full
            /\ dirty' = FALSE
            /\ flushedMid' = (flushedMid \/ phase = "req")
            /\ UNCHANGED <<comp, evt>>
  /\ UNCHANGED <<typed, phase, pre, sending, sent, queue, held, claimed, dropped,
                 lostOk, crea, pend, goal, wsDraft, listed, quits>>

\* Window B writes on top of the backend draft and A gets the change event.
TypeB(m) ==
  /\ TwoWindows /\ m \notin typed /\ crea = "none"
  /\ Simultaneous \/ ~dirty
  /\ typed' = typed \cup {m} /\ draft' = draft \cup {m} /\ evt' = TRUE
  /\ UNCHANGED <<base, comp, dirty, phase, pre, sending, flushedMid, sent, queue, held, claimed, dropped, lostOk,
                 crea, pend, goal, wsDraft, listed, quits>>

\* applyServerState: replaces only fields that are not dirty; a skipped event is not re-read.
Deliver ==
  /\ evt /\ ~(dirty /\ FixConditionalWrite)
  \* (With FixKeepUntilAccepted the draft also holds the in-flight send's text, which the
  \* composer does not show.)
  /\ comp' = IF dirty THEN comp ELSE draft \ (IF phase = "req" THEN sending ELSE {})
  /\ base' = IF dirty THEN base ELSE comp'
  \* The code adopts the event's revision even when it skips the text; with the conditional
  \* write, the skipped change stays pending until the composer's next write sees it.
  /\ evt' = (dirty /\ FixConditionalWrite)
  /\ UNCHANGED <<typed, dirty, draft, phase, pre, sending, flushedMid, sent, queue, held, claimed, dropped,
                 lostOk, crea, pend, goal, wsDraft, listed, quits>>

-----------------------------------------------------------------------------
(* Window A: send (workspace composer).                                    *)

Send ==
  /\ ~WithCreation /\ Idle /\ Quiet /\ comp # {}
  /\ phase' = "req" /\ pre' = comp /\ sending' = comp /\ flushedMid' = FALSE
  /\ comp' = {} /\ dirty' = TRUE            \* removeSentText of the whole input
  /\ UNCHANGED <<typed, draft, base, evt, sent, queue, held, claimed, dropped, lostOk, crea, pend,
                 goal, wsDraft, listed, quits>>

\* The backend accepts: a direct turn (transcript) or the send queue.
\* With FixKeepUntilAccepted the backend removes the accepted text from the draft in the same
\* step (a send that names its draft scope), so nothing has to clear it afterwards.
AcceptedDraft == IF FixKeepUntilAccepted THEN draft \ sending ELSE draft

AcceptDirect ==
  /\ phase = "req"
  /\ phase' = "acc" /\ sent' = Inc(sent, sending) /\ draft' = AcceptedDraft
  /\ UNCHANGED <<base, typed, comp, dirty, evt, pre, sending, flushedMid, queue, held, claimed, dropped,
                 lostOk, crea, pend, goal, wsDraft, listed, quits>>
AcceptQueued ==
  /\ WithQueue /\ phase = "req"
  /\ phase' = "acc" /\ queue' = queue \cup sending /\ draft' = AcceptedDraft
  /\ UNCHANGED <<base, typed, comp, dirty, evt, pre, sending, flushedMid, sent, held, claimed, dropped,
                 lostOk, crea, pend, goal, wsDraft, listed, quits>>

RestoredComp == IF FixMergeRestore THEN comp \cup pre ELSE pre

\* Err before acceptance: setDraft(preSendDraft).
Refused ==
  /\ phase = "req"
  /\ comp' = RestoredComp /\ dirty' = TRUE
  /\ phase' = "none" /\ pre' = {} /\ sending' = {} /\ flushedMid' = FALSE
  /\ UNCHANGED <<typed, draft, base, evt, sent, queue, held, claimed, dropped, lostOk, crea, pend,
                 goal, wsDraft, listed, quits>>

ReplyOk ==
  /\ phase = "acc"
  /\ phase' = "none" /\ pre' = {} /\ sending' = {} /\ flushedMid' = FALSE
  /\ UNCHANGED <<typed, comp, dirty, draft, base, evt, sent, queue, held, claimed, dropped, lostOk,
                 crea, pend, goal, wsDraft, listed, quits>>

\* The backend accepted, but the reply is lost (transport error): restoreDraftOnError.
ReplyLost ==
  /\ phase = "acc"
  /\ IF FixNoRestoreAccepted THEN UNCHANGED <<comp, dirty>>
     ELSE comp' = RestoredComp /\ dirty' = TRUE
  /\ phase' = "none" /\ pre' = {} /\ sending' = {} /\ flushedMid' = FALSE
  /\ UNCHANGED <<typed, draft, base, evt, sent, queue, held, claimed, dropped, lostOk, crea, pend,
                 goal, wsDraft, listed, quits>>

-----------------------------------------------------------------------------
(* Backend queue and held inputs.                                          *)

Dispatch(m) ==
  /\ m \in queue
  /\ queue' = queue \ {m} /\ sent' = Inc(sent, {m})
  /\ UNCHANGED <<typed, comp, dirty, draft, base, evt, phase, pre, sending, flushedMid, held, claimed, dropped,
                 lostOk, crea, pend, goal, wsDraft, listed, quits>>

\* Dequeue-gate refusal (agentSession.ts:10811): held before the queue change is published.
DequeueRefused(m) ==
  /\ m \in queue
  /\ queue' = queue \ {m} /\ held' = held \cup {m}
  /\ UNCHANGED <<typed, comp, dirty, draft, base, evt, phase, pre, sending, flushedMid, sent, claimed, dropped,
                 lostOk, crea, pend, goal, wsDraft, listed, quits>>

\* Stop's restoreQueueToInput: every restorable queued entry is held ("interrupted").
Stop ==
  /\ WithQueue /\ queue # {}
  /\ held' = held \cup queue /\ queue' = {}
  /\ UNCHANGED <<typed, comp, dirty, draft, base, evt, phase, pre, sending, flushedMid, sent, claimed, dropped,
                 lostOk, crea, pend, goal, wsDraft, listed, quits>>

\* clearQueue: the user drops the queued input; held entries are untouched.
ClearQueue ==
  /\ WithQueue /\ queue # {}
  /\ dropped' = dropped \cup queue /\ queue' = {}
  /\ UNCHANGED <<typed, comp, dirty, draft, base, evt, phase, pre, sending, flushedMid, sent, held, claimed,
                 lostOk, crea, pend, goal, wsDraft, listed, quits>>

\* sendHeldInput: synchronous claim (busy if claimed), then a fresh manual send.
RetryClaim(m) ==
  /\ m \in held \ claimed
  /\ claimed' = claimed \cup {m}
  /\ UNCHANGED <<typed, comp, dirty, draft, base, evt, phase, pre, sending, flushedMid, sent, queue, held, dropped,
                 lostOk, crea, pend, goal, wsDraft, listed, quits>>

\* Ok: ownership moves to the transcript or the queue, then removeHeldInput; release in finally.
RetryOk(m) ==
  /\ m \in claimed
  /\ \/ sent' = Inc(sent, {m}) /\ UNCHANGED queue
     \/ queue' = queue \cup {m} /\ UNCHANGED sent
  /\ held' = held \ {m} /\ claimed' = claimed \ {m}
  /\ UNCHANGED <<typed, comp, dirty, draft, base, evt, phase, pre, sending, flushedMid, dropped, lostOk, crea,
                 pend, goal, wsDraft, listed, quits>>

\* Err before acceptance, rows rolled back: the entry stays held.
RetryErr(m) ==
  /\ m \in claimed
  /\ claimed' = claimed \ {m}
  /\ UNCHANGED <<typed, comp, dirty, draft, base, evt, phase, pre, sending, flushedMid, sent, queue, held, dropped,
                 lostOk, crea, pend, goal, wsDraft, listed, quits>>

\* Err after the user row became durable (rollback failed, markRowsDurable): still held.
RetryErrDurable(m) ==
  /\ RollbackFail /\ m \in claimed
  /\ sent' = Inc(sent, {m}) /\ claimed' = claimed \ {m}
  /\ UNCHANGED <<typed, comp, dirty, draft, base, evt, phase, pre, sending, flushedMid, queue, held, dropped,
                 lostOk, crea, pend, goal, wsDraft, listed, quits>>

\* discardHeldInput: refused (busy) while claimed.
Discard(m) ==
  /\ m \in held \ claimed
  /\ held' = held \ {m} /\ dropped' = dropped \cup {m}
  /\ UNCHANGED <<typed, comp, dirty, draft, base, evt, phase, pre, sending, flushedMid, sent, queue, claimed,
                 lostOk, crea, pend, goal, wsDraft, listed, quits>>

-----------------------------------------------------------------------------
(* Creation composer: /goal creates the workspace, then runs the command.  *)

\* handleSend: workspace created; clearPendingDraft deletes the creation draft (and its store
\* entry, so the composer shows nothing); the command runs with the input in memory.
CreateWithGoal ==
  /\ WithCreation /\ crea = "none" /\ phase = "none" /\ Quiet /\ comp # {}
  /\ crea' = "cmd" /\ pend' = comp /\ comp' = {} /\ dirty' = FALSE
  \* With FixCreationTransfer the creation draft (with the input) is kept until the command
  \* consumed it; the code deletes it here.
  /\ draft' = IF FixCreationTransfer THEN comp ELSE {}
  /\ listed' = (FixCreationTransfer /\ listed)
  /\ UNCHANGED <<base, typed, evt, phase, pre, sending, flushedMid, sent, queue, held, claimed, dropped, lostOk,
                 goal, wsDraft, quits>>

GoalConsumed ==
  /\ crea = "cmd"
  /\ goal' = goal \cup pend /\ pend' = {} /\ crea' = "done"
  /\ draft' = {} /\ listed' = FALSE
  /\ UNCHANGED <<base, typed, comp, dirty, evt, phase, pre, sending, flushedMid, sent, queue, held, claimed,
                 dropped, lostOk, wsDraft, quits>>

\* "restore" disposition (setGoal refused/threw, budget on an unpriced model): only a toast.
GoalNotConsumed ==
  /\ crea = "cmd"
  /\ wsDraft' = IF FixCreationTransfer THEN wsDraft \cup pend ELSE wsDraft
  /\ pend' = {} /\ crea' = "done"
  /\ draft' = {} /\ listed' = FALSE
  /\ UNCHANGED <<base, typed, comp, dirty, evt, phase, pre, sending, flushedMid, sent, queue, held, claimed,
                 dropped, lostOk, goal, quits>>

\* putCreationDraft lists the draft (async, after its first write).
ListCreationDraft ==
  /\ WithCreation /\ WithGc /\ crea = "none" /\ ~listed /\ draft # {}
  /\ listed' = TRUE
  /\ UNCHANGED <<typed, comp, dirty, draft, base, evt, phase, pre, sending, flushedMid, sent, queue, held, claimed,
                 dropped, lostOk, crea, pend, goal, wsDraft, quits>>

\* Draft GC: a listed or owned creation draft is kept; the list read may fail. The code aborts
\* on a failed strict read (drafts.getList); the mutant reads it as an empty list.
GcSweep ==
  /\ WithCreation /\ WithGc /\ crea = "none"
  /\ \/ /\ listed                                    \* read succeeds: listed draft kept
        /\ UNCHANGED <<draft, comp>>
     \/ /\ MutLaxGc /\ listed                        \* read fails, treated as empty
        /\ draft' = {} /\ comp' = IF dirty THEN comp ELSE {}
  /\ UNCHANGED <<base, typed, dirty, evt, phase, pre, sending, flushedMid, sent, queue, held, claimed, dropped,
                 lostOk, crea, pend, goal, wsDraft, listed, quits>>

-----------------------------------------------------------------------------
(* Quit or crash: renderer memory, in-flight requests, queue and held list *)
(* are gone; the composer reloads the backend draft. Quitting with queued *)
(* or held input is behind a restart blocker, so it is excluded here.      *)

Quit ==
  /\ WithQuit /\ quits = 0 /\ queue = {} /\ held = {}
  /\ quits' = quits + 1
  \* Accepted loss: unwritten typing, and the text of an in-flight send that was never written
  \* (no draft write since the send, so it was within the debounce window when sent).
  /\ lostOk' = lostOk \cup (IF dirty THEN comp \ draft ELSE {})
                      \cup (IF phase = "req" /\ ~flushedMid THEN sending \ draft ELSE {})
  /\ comp' = draft /\ base' = draft /\ dirty' = FALSE /\ evt' = FALSE
  /\ phase' = "none" /\ pre' = {} /\ sending' = {}  \* an unaccepted request dies with the backend
  /\ flushedMid' = FALSE
  /\ pend' = {} /\ crea' = IF crea = "cmd" THEN "done" ELSE crea
  /\ UNCHANGED <<typed, draft, sent, queue, held, claimed, dropped, goal, wsDraft, listed>>

-----------------------------------------------------------------------------
Next ==
  \/ \E m \in Msgs : TypeA(m) \/ TypeB(m) \/ Dispatch(m) \/ DequeueRefused(m)
                     \/ RetryClaim(m) \/ RetryOk(m) \/ RetryErr(m) \/ RetryErrDurable(m)
                     \/ Discard(m)
  \/ Flush \/ Deliver \/ Send \/ AcceptDirect \/ AcceptQueued \/ Refused \/ ReplyOk \/ ReplyLost
  \/ Stop \/ ClearQueue
  \/ CreateWithGoal \/ GoalConsumed \/ GoalNotConsumed \/ ListCreationDraft \/ GcSweep
  \/ Quit

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* Properties.                                                             *)

\* Where a token may live. `sending` counts only while its request is alive (renderer memory).
Safe == comp \cup draft \cup queue \cup held \cup goal \cup wsDraft \cup pend
        \cup {m \in Msgs : sent[m] > 0}
        \cup (IF phase # "none" THEN sending ELSE {})

\* Text the user typed is never silently lost.
NoSilentLoss == \A m \in typed : m \in Safe \/ m \in dropped \/ m \in lostOk

\* Nothing reaches the transcript twice.
NoDup == \A m \in Msgs : sent[m] <= 1

\* Once settled (no send or Retry in flight, no unsaved edit), a sent token is not offered
\* again in the composer, the draft or the held list.
NoResurrection ==
  (phase = "none" /\ claimed = {} /\ ~dirty) =>
    \A m \in Msgs : sent[m] > 0 => m \notin comp \cup draft \cup held
=============================================================================
