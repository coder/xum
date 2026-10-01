------------------------- MODULE CompactionProtocol -------------------------
(***************************************************************************)
(* Crash-consistency model of Xum's compaction protocols:                 *)
(*   - manual compaction publication + durable follow-up handoff           *)
(*     (compactionHandler.ts, compactionPendingState.ts:585,               *)
(*      historyService.ts:4914 persistBoundaryWithTailCopiesUnderWriteLock)*)
(*   - follow-up dispatch (agentSession.ts:10759 dispatchPendingFollowUp)  *)
(*   - Stop / compaction cancellation (compactionCancellation.ts:242)      *)
(*   - continuous-compaction journal + generation file                     *)
(*     (continuousCompactionJournal.ts, continuousCompactor.ts)            *)
(*   - edit truncation (agentSession.ts:4514, historyService.ts:5340)      *)
(*                                                                         *)
(* Every durable write in these paths is a single temp-file + rename       *)
(* (writeFileAtomic / publishCompactionFile), so each is ONE atomic step.  *)
(* Rows are abstract; the provider view is "rows from the latest boundary".*)
(* A crash loses a backend's memory and releases its locks (fileLock.ts    *)
(* assumed correct); disk survives. `lock` abstracts both history locks.   *)
(* Runs, bounds and expected outcomes live in check.sh.                    *)
(***************************************************************************)
EXTENDS Integers, Sequences, FiniteSets, TLC

CONSTANTS
  Backends,
  MaxCrashes, MaxChats, MaxCompactions, MaxEdits, MaxContinuous, MaxResets, MaxRecoveries,
  RecheckFollowUpUnderLock, \* FIX (implemented): the follow-up send re-verifies the handoff under the lock
  EditClearsFollowUp,       \* FIX (implemented): an edit that exposes a summary clears its pendingFollowUp
  MutJournalIgnoresGeneration, \* mutation: journal fold skips the stale-generation discard (272)
  MutNoInMemoryFence,       \* mutation: publish/dispatch ignore the Stop's in-memory fence and send-admission record check
  MutNoFoldIdempotence      \* mutation: journal fold ignores an already-present boundary

NONE == "none"
NoJournal == [g |-> -1, snap |-> <<>>, cid |-> 0]
NoRecord == [cid |-> 0]

Row(id, k, cid, fu) == [id |-> id, k |-> k, cid |-> cid, fu |-> fu]

VARIABLES
  hist,      \* chat.jsonl rows (archive folded in; rotation is not modeled)
  gen,       \* continuous-compaction generation file (opaque bytes; modeled as a counter)
  journal,   \* continuous-compaction journal file
  record,    \* compaction cancellation record
  lock,
  pc, mcid, g0, snap, stopping, dcid, after,
  nextId, chats, comps, edits, conts, resets, recs, crashes,
  dispatched,   \* ghost: cid -> number of follow-up user rows ever appended
  stopDone,     \* ghost: cids whose Stop published its record
  violations    \* ghost: set of violated protocol facts observed at their commit point

vars == <<hist, gen, journal, record, lock, pc, mcid, g0, snap, stopping, dcid, after,
          nextId, chats, comps, edits, conts, resets, recs, crashes, dispatched, stopDone, violations>>

Cids == 1..MaxCompactions + MaxContinuous
Free == lock = NONE
Last == IF hist = <<>> THEN Row(0, "none", 0, FALSE) ELSE hist[Len(hist)]
HasBoundary(c) == \E i \in 1..Len(hist) : hist[i].k = "sum" /\ hist[i].cid = c
ClearFollowUps(h) == [i \in 1..Len(h) |-> [h[i] EXCEPT !.fu = FALSE]]

Init ==
  /\ hist = <<>> /\ gen = 0 /\ journal = NoJournal /\ record = NoRecord /\ lock = NONE
  /\ pc = [b \in Backends |-> "idle"] /\ mcid = [b \in Backends |-> 0]
  /\ g0 = [b \in Backends |-> 0] /\ snap = [b \in Backends |-> <<>>]
  /\ stopping = [b \in Backends |-> 0] /\ dcid = [b \in Backends |-> 0]
  /\ after = [b \in Backends |-> "idle"]
  /\ nextId = 1 /\ chats = 0 /\ comps = 0 /\ edits = 0 /\ conts = 0 /\ resets = 0
  /\ recs = 0 /\ crashes = 0
  /\ dispatched = [c \in Cids |-> 0] /\ stopDone = {} /\ violations = {}

Local == <<mcid, g0, snap, stopping, dcid, after>>
Bounds == <<chats, comps, edits, conts, resets, recs, crashes>>
Idle(b) == pc[b] = "idle"
Goto(b, p) == pc' = [pc EXCEPT ![b] = p]

---------------------------------------------------------------------------
(* Ordinary turn: user row + assistant row (appendToHistory, O_APPEND).    *)
Chat(b) ==
  /\ Idle(b) /\ chats < MaxChats /\ Free
  /\ hist' = hist \o <<Row(nextId, "user", 0, FALSE), Row(nextId + 1, "asst", 0, FALSE)>>
  /\ nextId' = nextId + 2 /\ chats' = chats + 1
  /\ UNCHANGED <<gen, journal, record, lock, pc, Local, comps, edits, conts, resets, recs,
                 crashes, dispatched, stopDone, violations>>

---------------------------------------------------------------------------
(* Manual compaction with a follow-up. Capture: the publication generation *)
(* (captureGeneration, continuousCompactionJournal.ts:142) and the snapshot *)
(* the summary is built from.                                              *)
McStart(b) ==
  /\ Idle(b) /\ comps < MaxCompactions /\ Free
  /\ mcid' = [mcid EXCEPT ![b] = comps + 1]
  /\ g0' = [g0 EXCEPT ![b] = gen]
  /\ snap' = [snap EXCEPT ![b] = hist]
  /\ comps' = comps + 1
  /\ Goto(b, "mc_publish")
  /\ UNCHANGED <<hist, gen, journal, record, lock, stopping, dcid, after, nextId, chats, edits, conts,
                 resets, recs, crashes, dispatched, stopDone, violations>>

\* compactionPendingState.ts:585 -> historyService.ts:798 publishBoundary ->
\* persistBoundaryWithTailCopiesUnderWriteLock (4914): isPublicationCurrent (4932) +
\* shouldPersist snapshot fingerprint + isCurrent, then ONE publishCompactionFile rename.
McPublish(b) ==
  /\ pc[b] = "mc_publish" /\ Free
  /\ IF (stopping[b] = 0 \/ MutNoInMemoryFence) /\ gen = g0[b] /\ hist = snap[b]
       THEN /\ hist' = Append(hist, Row(nextId, "sum", mcid[b], TRUE))
            /\ nextId' = nextId + 1
            /\ violations' = violations \cup
                 (IF mcid[b] \in stopDone THEN {"boundary-after-stop"} ELSE {})
            /\ dcid' = [dcid EXCEPT ![b] = mcid[b]]
            /\ Goto(b, "d_check")          \* stream-end targeted dispatch (agentSession.ts:12087)
       ELSE /\ UNCHANGED <<hist, nextId, violations, dcid>>
            /\ Goto(b, "idle")
  /\ UNCHANGED <<gen, journal, record, lock, mcid, g0, snap, stopping, after, chats, comps, edits, conts,
                 resets, recs, crashes, dispatched, stopDone>>

(* Stop during compaction: in-memory fence first (compactionStopGeneration, *)
(* isCurrent), then under the storage lock (compactionCancellation.ts:266): *)
(* advance generation (298), neutralize handoffs (332 -> historyService.ts: *)
(* 866), publish the record (340).                                          *)
StopBegin(b) ==
  /\ pc[b] \in {"mc_publish", "d_check", "d_send"} /\ stopping[b] = 0 /\ Free
  /\ stopping' = [stopping EXCEPT ![b] = 1]
  /\ lock' = b
  /\ gen' = gen + 1                                                   \* 298
  /\ UNCHANGED <<hist, journal, record, pc, mcid, g0, snap, dcid, after, nextId, Bounds,
                 dispatched, stopDone, violations>>
StopNeutralize(b) ==                                                  \* 332 -> 866
  /\ stopping[b] = 1 /\ lock = b
  /\ hist' = ClearFollowUps(hist)
  /\ stopping' = [stopping EXCEPT ![b] = 2]
  /\ UNCHANGED <<gen, journal, record, lock, pc, mcid, g0, snap, dcid, after, nextId, Bounds,
                 dispatched, stopDone, violations>>
StopRecord(b) ==                                                      \* 340
  /\ stopping[b] = 2 /\ lock = b
  /\ record' = [cid |-> mcid[b]]
  /\ stopDone' = stopDone \cup {mcid[b]}
  /\ lock' = NONE
  /\ stopping' = [stopping EXCEPT ![b] = 3]
  /\ UNCHANGED <<hist, gen, journal, pc, mcid, g0, snap, dcid, after, nextId, Bounds, dispatched,
                 violations>>

---------------------------------------------------------------------------
(* Follow-up dispatch (agentSession.ts:10759). d_check reads history and    *)
(* the cancellation record outside the history write lock; d_send is        *)
(* sendMessage (11176): automatic-send admission re-reads the cancellation  *)
(* record (4172-4186). Pre-fix, nothing re-verified the handoff under the   *)
(* lock; RecheckFollowUpUnderLock models the implemented re-check.          *)
Handoff(c) == Last.k = "sum" /\ Last.fu /\ (c = 0 \/ Last.cid = c)
Canceled == record.cid # 0 /\ record.cid = Last.cid

DCheck(b) ==
  /\ pc[b] = "d_check" /\ Free
  /\ IF Handoff(dcid[b]) /\ ~Canceled /\ (stopping[b] = 0 \/ MutNoInMemoryFence)
       THEN /\ dcid' = [dcid EXCEPT ![b] = Last.cid] /\ Goto(b, "d_send")
            /\ UNCHANGED <<hist, record, lock>>
       ELSE IF Handoff(dcid[b]) /\ Canceled
         THEN \* 10930-10935: clear the canceled handoff and retire the record
              /\ hist' = [hist EXCEPT ![Len(hist)].fu = FALSE]
              /\ record' = NoRecord
              /\ Goto(b, "idle") /\ UNCHANGED <<dcid, lock>>
         ELSE /\ Goto(b, "idle") /\ UNCHANGED <<hist, record, dcid, lock>>
  /\ UNCHANGED <<gen, journal, mcid, g0, snap, stopping, after, nextId, Bounds, dispatched, stopDone,
                 violations>>

DSend(b) ==
  /\ pc[b] = "d_send" /\ Free
  /\ IF (stopping[b] # 0 /\ ~MutNoInMemoryFence) \/ (record.cid # 0 /\ ~MutNoInMemoryFence)
        \/ (RecheckFollowUpUnderLock /\ ~(Handoff(dcid[b]) /\ ~Canceled))
       THEN /\ Goto(b, "idle") /\ UNCHANGED <<hist, nextId, dispatched, violations>>
       ELSE /\ hist' = hist \o <<Row(nextId, "fuUser", dcid[b], FALSE),
                                  Row(nextId + 1, "asst", 0, FALSE)>>
            /\ nextId' = nextId + 2
            /\ dispatched' = [dispatched EXCEPT ![dcid[b]] = @ + 1]
            /\ violations' = violations \cup
                 (IF dcid[b] \in stopDone THEN {"dispatch-after-stop"} ELSE {})
            /\ Goto(b, "idle")
  /\ UNCHANGED <<gen, journal, record, lock, mcid, g0, snap, stopping, dcid, after, Bounds, stopDone>>

---------------------------------------------------------------------------
(* Startup recovery (session creation / after a crash): journal recovery    *)
(* (continuousCompactor.ts:600), then the untargeted follow-up dispatch.    *)
Recover(b) ==
  /\ Idle(b) /\ recs < MaxRecoveries
  /\ recs' = recs + 1
  /\ dcid' = [dcid EXCEPT ![b] = 0]
  /\ after' = [after EXCEPT ![b] = "d_check"]
  /\ Goto(b, IF journal # NoJournal THEN "cc_fold" ELSE "d_check")
  /\ UNCHANGED <<hist, gen, journal, record, lock, mcid, g0, snap, stopping, nextId, chats, comps,
                 edits, conts, resets, crashes, dispatched, stopDone, violations>>

---------------------------------------------------------------------------
(* Edit: truncateAfterMessage (5340) publishes the cut and advances the      *)
(* generation (5435) in one locked operation; the edited user row is        *)
(* appended later by the same sendMessage (agentSession.ts:4604+).           *)
EditCut(b) ==
  /\ Idle(b) /\ edits < MaxEdits /\ Free
  /\ \E i \in 1..Len(hist) :
       /\ hist[i].k \in {"user", "fuUser"}
       /\ LET kept == SubSeq(hist, 1, i - 1) IN
            hist' = IF EditClearsFollowUp /\ kept # <<>> /\ kept[Len(kept)].k = "sum"
                      THEN [kept EXCEPT ![Len(kept)].fu = FALSE] ELSE kept
  /\ gen' = gen + 1
  /\ edits' = edits + 1
  /\ Goto(b, "edit_append")
  /\ UNCHANGED <<journal, record, lock, Local, nextId, chats, comps, conts, resets, recs, crashes,
                 dispatched, stopDone, violations>>
EditAppend(b) ==
  /\ pc[b] = "edit_append" /\ Free
  /\ hist' = hist \o <<Row(nextId, "user", 0, FALSE), Row(nextId + 1, "asst", 0, FALSE)>>
  /\ nextId' = nextId + 2
  /\ Goto(b, "idle")
  /\ UNCHANGED <<gen, journal, record, lock, Local, Bounds, dispatched, stopDone, violations>>

---------------------------------------------------------------------------
(* Continuous compaction. Journal write (continuousCompactionJournal.ts:340)*)
(* requires the captured generation to be current (351); fold               *)
(* (continuousCompactor.ts:628) re-reads the journal, discards a stale      *)
(* generation (journal read, 272), treats a present boundary as folded      *)
(* (656-664), otherwise publishes the boundary under the same fence, then   *)
(* clears the exact journal (623).                                          *)
CcStart(b) ==
  /\ Idle(b) /\ conts < MaxContinuous /\ Free
  /\ mcid' = [mcid EXCEPT ![b] = MaxCompactions + conts + 1]
  /\ g0' = [g0 EXCEPT ![b] = gen]
  /\ snap' = [snap EXCEPT ![b] = hist]
  /\ conts' = conts + 1
  /\ after' = [after EXCEPT ![b] = "idle"]
  /\ Goto(b, "cc_journal")
  /\ UNCHANGED <<hist, gen, journal, record, lock, stopping, dcid, nextId, chats, comps, edits,
                 resets, recs, crashes, dispatched, stopDone, violations>>
CcJournal(b) ==
  /\ pc[b] = "cc_journal" /\ Free
  /\ IF gen = g0[b]
       THEN journal' = [g |-> g0[b], snap |-> snap[b], cid |-> mcid[b]] /\ Goto(b, "cc_fold")
       ELSE UNCHANGED journal /\ Goto(b, "idle")
  /\ UNCHANGED <<hist, gen, record, lock, Local, nextId, Bounds, dispatched, stopDone, violations>>
CcFold(b) ==
  /\ pc[b] = "cc_fold" /\ Free
  /\ IF journal = NoJournal THEN
       /\ Goto(b, after[b]) /\ UNCHANGED <<hist, journal, nextId, violations>>
     ELSE IF journal.g # gen /\ ~MutJournalIgnoresGeneration THEN  \* 272-273 discard stale
       /\ journal' = NoJournal /\ Goto(b, after[b]) /\ UNCHANGED <<hist, nextId, violations>>
     ELSE IF HasBoundary(journal.cid) /\ ~MutNoFoldIdempotence THEN  \* 656-664 already folded
       /\ journal' = NoJournal /\ Goto(b, after[b]) /\ UNCHANGED <<hist, nextId, violations>>
     ELSE IF hist = journal.snap \/ MutNoFoldIdempotence THEN        \* source fingerprint
       /\ hist' = Append(hist, Row(nextId, "sum", journal.cid, FALSE))
       /\ nextId' = nextId + 1
       /\ violations' = violations \cup (IF HasBoundary(journal.cid) THEN {"double-fold"} ELSE {})
                                    \cup (IF journal.g # gen THEN {"stale-fold"} ELSE {})
       /\ Goto(b, "cc_clear") /\ UNCHANGED journal
     ELSE
       /\ journal' = NoJournal /\ Goto(b, after[b]) /\ UNCHANGED <<hist, nextId, violations>>
  /\ UNCHANGED <<gen, record, lock, Local, Bounds, dispatched, stopDone>>
CcClear(b) ==      \* store.clear(journal): exact unlink (211-212)
  /\ pc[b] = "cc_clear" /\ Free
  /\ journal' = NoJournal
  /\ Goto(b, after[b])
  /\ UNCHANGED <<hist, gen, record, lock, Local, nextId, Bounds, dispatched, stopDone, violations>>

\* Explicit reset (user-interrupt / edit / context-mutation / compaction-request):
\* clearForReset (215) unlinks on the LOCAL queue, without the history lock.
ClearForReset(b) ==
  /\ resets < MaxResets
  /\ journal' = NoJournal
  /\ resets' = resets + 1
  /\ UNCHANGED <<hist, gen, record, lock, pc, Local, nextId, chats, comps, edits, conts, recs,
                 crashes, dispatched, stopDone, violations>>

---------------------------------------------------------------------------
Crash(b) ==
  /\ crashes < MaxCrashes /\ (~Idle(b) \/ stopping[b] # 0)
  /\ pc' = [pc EXCEPT ![b] = "idle"]
  /\ stopping' = [stopping EXCEPT ![b] = 0]
  /\ lock' = IF lock = b THEN NONE ELSE lock
  /\ crashes' = crashes + 1
  /\ UNCHANGED <<hist, gen, journal, record, mcid, g0, snap, dcid, after, nextId, chats, comps,
                 edits, conts, resets, recs, dispatched, stopDone, violations>>

\* A stopped compaction ends; the backend becomes idle again.
StopSettle(b) ==
  /\ stopping[b] = 3 /\ pc[b] = "idle"
  /\ stopping' = [stopping EXCEPT ![b] = 0]
  /\ UNCHANGED <<hist, gen, journal, record, lock, pc, mcid, g0, snap, dcid, after, nextId, Bounds,
                 dispatched, stopDone, violations>>

StoppedAbandon(b) ==   \* the compaction thread observes the Stop and gives up
  /\ stopping[b] # 0 /\ pc[b] \in {"mc_publish", "d_check", "d_send"}
  /\ Goto(b, "idle")
  /\ UNCHANGED <<hist, gen, journal, record, lock, Local, nextId, Bounds, dispatched, stopDone,
                 violations>>

Next ==
  \E b \in Backends :
    \/ Chat(b) \/ McStart(b) \/ McPublish(b) \/ StopBegin(b) \/ StopNeutralize(b) \/ StopRecord(b)
    \/ StopSettle(b) \/ StoppedAbandon(b)
    \/ DCheck(b) \/ DSend(b) \/ Recover(b) \/ EditCut(b) \/ EditAppend(b)
    \/ CcStart(b) \/ CcJournal(b) \/ CcFold(b) \/ CcClear(b) \/ ClearForReset(b)
    \/ Crash(b)

Spec == Init /\ [][Next]_vars

---------------------------------------------------------------------------
(* Invariants *)
\* A pending follow-up runs at most once, across crashes and edits.
FollowUpAtMostOnce == \A c \in Cids : dispatched[c] <= 1

\* A completed Stop is honored: its compaction neither publishes nor dispatches.
StopHonored == violations \cap {"boundary-after-stop", "dispatch-after-stop"} = {}

\* A journal is folded at most once and never after its generation was superseded.
FoldOnce == "double-fold" \notin violations
NoStaleFold == "stale-fold" \notin violations
NoStaleJournal == journal # NoJournal => journal.g <= gen

\* Each compaction id owns at most one boundary row.
BoundaryOnce == \A c \in Cids :
  Cardinality({i \in 1..Len(hist) : hist[i].k = "sum" /\ hist[i].cid = c}) <= 1

TypeOK == lock \in Backends \cup {NONE}
=============================================================================
