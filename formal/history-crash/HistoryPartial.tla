---------------------------- MODULE HistoryPartial ----------------------------
(***************************************************************************)
(* Crash-consistency model of the partial-message lifecycle of            *)
(* HistoryService (src/node/services/historyService.ts) and its callers.  *)
(*                                                                         *)
(* Disk state: chat.jsonl (a sequence of JSONL lines) and partial.json.    *)
(* Every filesystem call is ONE atomic step, annotated with file:line.     *)
(* Line numbers refer to historyService.ts before the F1/F2 fix; with     *)
(* CommitRequiresRow = UpdateMatchesId = TRUE the model is the current code. *)
(* Semantics assumed (process-crash model; runs and bounds in check.sh):                    *)
(*   - writeFileAtomic (temp + fsync + rename) is all-or-nothing;          *)
(*   - unlink is atomic;                                                   *)
(*   - an O_APPEND append is NOT atomic across a crash: TornCrash leaves   *)
(*     a torn (unparseable) last line;                                      *)
(*   - a crash loses the crashing backend's memory (pc, sequence counter,  *)
(*     stream state) and releases its locks; disk state survives.          *)
(* The cross-process history write lock (fileLock.ts) is an abstract       *)
(* mutex `lock`; deletePartial* only take the in-process mutex, so they    *)
(* are modeled WITHOUT `lock` (historyService.ts:3100, 3159).              *)
(***************************************************************************)
EXTENDS Integers, Sequences, FiniteSets, TLC

CONSTANTS
  Backends,              \* e.g. {"b1","b2"}: backends sharing one workspace
  MaxTurns,              \* total stream turns (all backends)
  MaxEdits,              \* total edit truncations
  MaxCrashes,            \* total crashes
  MaxParts,              \* partial flushes per turn
  CrossBackendBusyGuard, \* TRUE = hypothetical guard: edit refused while ANY backend streams
  CompleteDeletesFirst,  \* TRUE = code order streamManager.ts:4935 (deletePartial before updateHistory)
  RetirePartialOnEdit,   \* TRUE = code (historyService.ts:5478); FALSE = pre-retirement builds
  CommitRequiresRow,     \* FIX (current code, F1/F2): commitPartial retires a partial whose id has no row
  UpdateMatchesId,       \* FIX (current code, F1/F2): updateHistory refuses a same-seq row with another id
  MutUnlinkFirst,        \* mutation: commitPartial unlinks partial.json before writing chat.jsonl
  ConcurrentStreams,     \* TRUE = a backend may start a turn while another backend's turn runs
  MutNoSeparator         \* mutation: append does not delimit a torn tail (historyAppendProvenance.ts:325)

NONE == "none"
NoRec == [id |-> 0, seq |-> -1, parts |-> 0]   \* absent partial.json / no active stream

VARIABLES
  chat,        \* Seq of [id, role, seq, parts, torn]
  partial,     \* NoRec or [id, seq, parts]
  lock,        \* NONE or holder backend (abstract cross-process mutex)
  pc,          \* per-backend program counter
  turn,        \* per-backend in-memory stream: NoRec or [id, seq, parts]
  counter,     \* per-backend cached next historySequence (-1 = not loaded)
  pend,        \* per-backend scratch (removed ids of an edit, commit decision)
  nextId,      \* id supply (UUIDs: never reused)
  turns, edits, crashes,
  committed,   \* ghost: ids of rows whose append/update completed and were not deliberately removed
  discarded,   \* ghost: assistant ids of turns an edit truncation removed
  streamed,    \* ghost: assistant ids whose content was flushed to partial.json and not deliberately abandoned
  commitErrs   \* ghost: commitPartial returned Err (the send path then fails, agentSession.ts:7657)

vars == <<chat, partial, lock, pc, turn, counter, pend, nextId, turns, edits, crashes,
          committed, discarded, streamed, commitErrs>>

Row(id, role, sq, parts) == [id |-> id, role |-> role, seq |-> sq, parts |-> parts, torn |-> FALSE]

ReadIdx == {i \in 1..Len(chat) : ~chat[i].torn}
Seqs == {chat[i].seq : i \in ReadIdx}
MaxSeq == IF Seqs = {} THEN -1 ELSE CHOOSE s \in Seqs : \A t \in Seqs : t <= s
IdxOfSeq(s) == IF \E i \in ReadIdx : chat[i].seq = s
                 THEN CHOOSE i \in ReadIdx : chat[i].seq = s /\ \A j \in ReadIdx : chat[j].seq = s => i <= j
                 ELSE 0
IdsIn(c) == {c[i].id : i \in {j \in 1..Len(c) : ~c[j].torn}}

\* historyAppendProvenance.ts:318-330: a torn tail is delimited by prepending "\n",
\* so the new row stays a separate, readable line.
AppendLine(l) ==
  IF MutNoSeparator /\ Len(chat) > 0 /\ chat[Len(chat)].torn
    THEN [chat EXCEPT ![Len(chat)] = [l EXCEPT !.torn = TRUE]]   \* merged garbage line
    ELSE Append(chat, l)

\* refreshSequenceCounterUnderWriteLock (historyService.ts:3666), called first by
\* appendToHistoryUnderWriteLock (3758).
Refreshed(b) == IF counter[b] = -1 \/ MaxSeq + 1 > counter[b] THEN MaxSeq + 1 ELSE counter[b]

Init ==
  /\ chat = <<>>
  /\ partial = NoRec
  /\ lock = NONE
  /\ pc = [b \in Backends |-> "idle"]
  /\ turn = [b \in Backends |-> NoRec]
  /\ counter = [b \in Backends |-> -1]
  /\ pend = [b \in Backends |-> NONE]
  /\ nextId = 1
  /\ turns = 0 /\ edits = 0 /\ crashes = 0
  /\ committed = {} /\ discarded = {} /\ streamed = {}
  /\ commitErrs = 0

Free == lock = NONE

---------------------------------------------------------------------------
(* Send: append the user row (agentSession sendMessage -> appendToHistory, *)
(* historyService.ts:3701/3754; O_APPEND at historyAppendProvenance.ts:333) *)
StartSend(b) ==
  /\ pc[b] = "idle" /\ turns < MaxTurns /\ Free
  /\ ConcurrentStreams \/ \A x \in Backends \ {b} : pc[x] \in {"idle", "edit_retire"}
  /\ LET s == Refreshed(b) IN
       /\ chat' = AppendLine(Row(nextId, "user", s, 0))
       /\ counter' = [counter EXCEPT ![b] = s + 1]
       /\ committed' = committed \cup {nextId}
  /\ nextId' = nextId + 1
  /\ turns' = turns + 1
  /\ pc' = [pc EXCEPT ![b] = "cp_any"]
  /\ UNCHANGED <<partial, lock, turn, pend, edits, crashes, discarded, streamed, commitErrs>>

(* commitPartial (historyService.ts:3206) as a sub-procedure. It is called  *)
(* with no expected id at stream start (agentSession.ts:7656,              *)
(* aiService.ts:970) and with the stream's id on abort (streamManager.ts:  *)
(* 2350). Step C1 = lock + read partial + read history + first mutation.   *)
CommitDecide(b, expected, retPc) ==
  /\ Free
  /\ IF partial = NoRec \/ (expected # 0 /\ partial.id # expected)
       THEN \* 3209 lock-free probe / 3228 expected-id guard: nothing to do
            /\ pc' = [pc EXCEPT ![b] = retPc]
            /\ UNCHANGED <<chat, partial, lock, counter, pend, committed, commitErrs>>
       ELSE
         LET p == partial
             ei == IdxOfSeq(p.seq)                     \* 3259 existingMessage (by seq)
             existing == ei # 0 /\ (UpdateMatchesId => chat[ei].id = p.id)
             orphan == CommitRequiresRow /\ p.id \notin IdsIn(chat)
             stale == (~existing /\ MaxSeq >= p.seq) \/ orphan  \* 3264-3279 stale non-tail partial
             should == (~existing \/ p.parts > chat[ei].parts) /\ p.parts > 0  \* 3281-3285
             row == Row(p.id, "assistant", p.seq, p.parts)
             c == Refreshed(b)
         IN
         IF stale \/ ~should
           THEN \* 3279 / 3317 deletePartialUnlocked: unlink (3107)
                /\ partial' = NoRec
                /\ pc' = [pc EXCEPT ![b] = retPc]
                /\ UNCHANGED <<chat, lock, counter, pend, committed, commitErrs>>
           ELSE IF ~existing /\ p.seq < c
             THEN \* 3391-3395: "Refusing to append stale historySequence" -> Err; partial kept
                  /\ commitErrs' = commitErrs + 1
                  /\ counter' = [counter EXCEPT ![b] = c]
                  /\ pc' = [pc EXCEPT ![b] = retPc]
                  /\ UNCHANGED <<chat, partial, lock, pend, committed>>
           ELSE
             \* existing: 3296 updateHistoryUnderWriteLock -> writeFileAtomic (atomic, by seq)
             \* else:     3301 appendToHistoryUnderWriteLock -> O_APPEND
             /\ lock' = b
             /\ pc' = [pc EXCEPT ![b] = "c_unlink"]
             /\ pend' = [pend EXCEPT ![b] = [ret |-> retPc, idx |-> IF existing THEN ei ELSE 0, row |-> row]]
             /\ counter' = IF existing THEN counter ELSE [counter EXCEPT ![b] = p.seq + 1]
             /\ IF MutUnlinkFirst
                  THEN \* mutation: unlink partial.json first, write chat.jsonl in the next step
                       /\ partial' = NoRec
                       /\ UNCHANGED <<chat, committed, commitErrs>>
                  ELSE /\ chat' = IF existing THEN [chat EXCEPT ![ei] = row] ELSE AppendLine(row)
                       /\ committed' = committed \cup {p.id}
                       /\ UNCHANGED <<partial, commitErrs>>
  /\ UNCHANGED <<turn, nextId, turns, edits, crashes, discarded, streamed>>

\* 3317 deletePartialUnlocked -> fs.unlink (3107), then the lock is released.
CommitUnlink(b) ==
  /\ pc[b] = "c_unlink" /\ lock = b
  /\ IF MutUnlinkFirst
       THEN LET q == pend[b] IN
            /\ chat' = IF q.idx # 0 THEN [chat EXCEPT ![q.idx] = q.row] ELSE AppendLine(q.row)
            /\ committed' = committed \cup {q.row.id}
            /\ UNCHANGED partial
       ELSE /\ partial' = NoRec
            /\ UNCHANGED <<chat, committed>>
  /\ lock' = NONE
  /\ pc' = [pc EXCEPT ![b] = pend[b].ret]
  /\ pend' = [pend EXCEPT ![b] = NONE]
  /\ UNCHANGED <<turn, counter, nextId, turns, edits, crashes, discarded, streamed, commitErrs>>

\* Stream start commit (aiService.ts:970), then the placeholder append
\* (turnRequestBuilder.ts:3160, empty assistant row).
CommitAtStart(b) == pc[b] = "cp_any" /\ CommitDecide(b, 0, "placeholder")

Placeholder(b) ==
  /\ pc[b] = "placeholder" /\ Free
  /\ LET s == Refreshed(b) IN
       /\ chat' = AppendLine(Row(nextId, "assistant", s, 0))
       /\ counter' = [counter EXCEPT ![b] = s + 1]
       /\ turn' = [turn EXCEPT ![b] = [id |-> nextId, seq |-> s, parts |-> 0]]
       /\ committed' = committed \cup {nextId}
  /\ nextId' = nextId + 1
  /\ pc' = [pc EXCEPT ![b] = "stream"]
  /\ UNCHANGED <<partial, lock, pend, turns, edits, crashes, discarded, streamed, commitErrs>>

\* writePartial -> writePartialUnderWriteLock (3072) -> writeFileAtomic (3093).
\* Only the removal tombstone is checked; nothing verifies the placeholder row still exists.
WritePartial(b) ==
  /\ pc[b] = "stream" /\ turn[b].parts < MaxParts /\ Free
  /\ LET t == [turn[b] EXCEPT !.parts = @ + 1] IN
       /\ turn' = [turn EXCEPT ![b] = t]
       /\ partial' = [id |-> t.id, seq |-> t.seq, parts |-> t.parts]
       /\ streamed' = streamed \cup {t.id}
  /\ UNCHANGED <<chat, lock, pc, counter, pend, nextId, turns, edits, crashes, committed,
                 discarded, commitErrs>>

\* Normal completion (streamManager.ts:4914-4946): deletePartial + updateHistory(final).
FinishBegin(b) ==
  /\ pc[b] = "stream" /\ turn[b].parts > 0
  /\ pc' = [pc EXCEPT ![b] = IF CompleteDeletesFirst THEN "fin_del" ELSE "fin_upd"]
  /\ UNCHANGED <<chat, partial, lock, turn, counter, pend, nextId, turns, edits, crashes,
                 committed, discarded, streamed, commitErrs>>

\* streamManager.ts:4935 deletePartial -> fs.unlink (3107), in-process lock only.
FinishDelete(b) ==
  /\ pc[b] = "fin_del"
  /\ partial' = IF CompleteDeletesFirst \/ (partial # NoRec /\ partial.id = turn[b].id)
                  THEN NoRec ELSE partial
  /\ pc' = [pc EXCEPT ![b] = IF CompleteDeletesFirst THEN "fin_upd" ELSE "idle"]
  /\ turn' = IF CompleteDeletesFirst THEN turn ELSE [turn EXCEPT ![b] = NoRec]
  /\ UNCHANGED <<chat, lock, counter, pend, nextId, turns, edits, crashes, committed,
                 discarded, streamed, commitErrs>>

\* streamManager.ts:4943 updateHistory -> updateHistoryUnderWriteLock (4785): replaces the
\* FIRST row whose historySequence matches (4812), whatever its id; Err if none (4844).
\* UpdateMatchesId = TRUE (current code): the row must also carry the message id.
FinishUpdate(b) ==
  /\ pc[b] = "fin_upd" /\ Free
  /\ LET t == turn[b]
         ei == IdxOfSeq(t.seq)
         hit == ei # 0 /\ (UpdateMatchesId => chat[ei].id = t.id)
     IN /\ chat' = IF hit THEN [chat EXCEPT ![ei] = Row(t.id, "assistant", t.seq, t.parts)] ELSE chat
        /\ committed' = IF hit THEN committed \cup {t.id} ELSE committed
  /\ pc' = [pc EXCEPT ![b] = IF CompleteDeletesFirst THEN "idle" ELSE "fin_del"]
  /\ turn' = IF CompleteDeletesFirst THEN [turn EXCEPT ![b] = NoRec] ELSE turn
  /\ UNCHANGED <<partial, lock, counter, pend, nextId, turns, edits, crashes, discarded,
                 streamed, commitErrs>>

\* Abort that keeps content: commitPartial(workspaceId, messageId) (streamManager.ts:2350).
AbortCommit(b) ==
  /\ pc[b] = "stream"
  /\ pc' = [pc EXCEPT ![b] = "abort_cp"]
  /\ UNCHANGED <<chat, partial, lock, turn, counter, pend, nextId, turns, edits, crashes,
                 committed, discarded, streamed, commitErrs>>
AbortCommitRun(b) ==
  /\ pc[b] = "abort_cp"
  /\ CommitDecide(b, turn[b].id, "abort_done")
AbortDone(b) ==
  /\ pc[b] = "abort_done"
  /\ pc' = [pc EXCEPT ![b] = "idle"]
  /\ turn' = [turn EXCEPT ![b] = NoRec]
  /\ UNCHANGED <<chat, partial, lock, counter, pend, nextId, turns, edits, crashes,
                 committed, discarded, streamed, commitErrs>>

\* Abandoning abort: deletePartialIfMessageIdMatches (historyService.ts:3171, streamManager.ts:2346).
\* The user asked to discard this content, so it leaves the `streamed` obligation.
AbortAbandon(b) ==
  /\ pc[b] = "stream"
  /\ partial' = IF partial # NoRec /\ partial.id = turn[b].id THEN NoRec ELSE partial
  /\ streamed' = streamed \ {turn[b].id}
  /\ pc' = [pc EXCEPT ![b] = "idle"]
  /\ turn' = [turn EXCEPT ![b] = NoRec]
  /\ UNCHANGED <<chat, lock, counter, pend, nextId, turns, edits, crashes, committed,
                 discarded, commitErrs>>

---------------------------------------------------------------------------
(* Edit: truncateAfterMessage (historyService.ts:5340). The busy guard is   *)
(* process-local (agentSession edit waits for ITS session; workspaceService *)
(* checks this.aiService.isStreaming): it cannot see a foreign backend.     *)
EditTruncate(b) ==
  /\ pc[b] = "idle" /\ edits < MaxEdits /\ Free
  /\ CrossBackendBusyGuard => \A x \in Backends : turn[x] = NoRec
  /\ \E ti \in ReadIdx :
       /\ chat[ti].role = "user"
       /\ LET kept == SubSeq(chat, 1, ti - 1)
              removed == IdsIn(SubSeq(chat, ti, Len(chat)))
              keptSeqs == {kept[i].seq : i \in {j \in 1..Len(kept) : ~kept[j].torn}}
              nxt == IF keptSeqs = {} THEN 0
                     ELSE 1 + CHOOSE s \in keptSeqs : \A t \in keptSeqs : t <= s
          IN /\ chat' = kept                                   \* 5443 publishHistoryUnderWriteLock
             /\ counter' = [counter EXCEPT ![b] = nxt]         \* 5467-5476 counter := max kept + 1
             /\ discarded' = discarded \cup
                  {chat[i].id : i \in {j \in ti..Len(chat) : ~chat[j].torn /\ chat[j].role = "assistant"}}
             /\ committed' = committed \ removed
             /\ streamed' = streamed \ removed
             /\ pend' = [pend EXCEPT ![b] = removed]
  /\ lock' = b
  /\ edits' = edits + 1
  /\ pc' = [pc EXCEPT ![b] = "edit_retire"]
  /\ UNCHANGED <<partial, turn, nextId, turns, crashes, commitErrs>>

\* retirePartialOfRemovedRowsUnlocked (5615): unlink partial.json iff its id was removed.
EditRetire(b) ==
  /\ pc[b] = "edit_retire" /\ lock = b
  /\ partial' = IF RetirePartialOnEdit /\ partial # NoRec /\ partial.id \in pend[b]
                  THEN NoRec ELSE partial
  /\ lock' = NONE
  /\ pend' = [pend EXCEPT ![b] = NONE]
  /\ pc' = [pc EXCEPT ![b] = "idle"]
  /\ UNCHANGED <<chat, turn, counter, nextId, turns, edits, crashes, committed, discarded,
                 streamed, commitErrs>>

---------------------------------------------------------------------------
(* Crashes: memory is lost, the lock is released (stale-lock reclamation of *)
(* fileLock.ts is assumed correct), disk survives.                         *)
CrashReset(b) ==
  /\ pc' = [pc EXCEPT ![b] = "idle"]
  /\ turn' = [turn EXCEPT ![b] = NoRec]
  /\ counter' = [counter EXCEPT ![b] = -1]
  /\ pend' = [pend EXCEPT ![b] = NONE]
  /\ lock' = IF lock = b THEN NONE ELSE lock
  /\ crashes' = crashes + 1

Crash(b) ==
  /\ crashes < MaxCrashes /\ pc[b] # "idle"
  /\ CrashReset(b)
  /\ UNCHANGED <<chat, partial, nextId, turns, edits, committed, discarded, streamed, commitErrs>>

\* A crash in the middle of an O_APPEND write (user row / placeholder) leaves a torn line.
TornCrash(b) ==
  /\ crashes < MaxCrashes /\ Free
  /\ pc[b] \in {"idle", "placeholder"}
  /\ pc[b] = "idle" => turns < MaxTurns
  /\ chat' = Append(chat, [Row(nextId, IF pc[b] = "idle" THEN "user" ELSE "assistant", Refreshed(b), 0)
                           EXCEPT !.torn = TRUE])
  /\ nextId' = nextId + 1
  /\ turns' = IF pc[b] = "idle" THEN turns + 1 ELSE turns
  /\ CrashReset(b)
  /\ UNCHANGED <<partial, edits, committed, discarded, streamed, commitErrs>>

Next ==
  \E b \in Backends :
    \/ StartSend(b) \/ CommitAtStart(b) \/ CommitUnlink(b) \/ Placeholder(b)
    \/ WritePartial(b) \/ FinishBegin(b) \/ FinishDelete(b) \/ FinishUpdate(b)
    \/ AbortCommit(b) \/ AbortCommitRun(b) \/ AbortDone(b) \/ AbortAbandon(b)
    \/ EditTruncate(b) \/ EditRetire(b)
    \/ Crash(b) \/ TornCrash(b)

Spec == Init /\ [][Next]_vars

---------------------------------------------------------------------------
(* Invariants *)
\* No row of a turn that an edit discarded is ever (re)committed to chat.jsonl.
NoGhostRow == \A i \in ReadIdx : chat[i].id \notin discarded

\* No duplicated row (e.g. a partial committed twice).
NoDuplicateRow == \A i, j \in ReadIdx : i # j => chat[i].id # chat[j].id

\* historySequence stays unique (updateHistory matches by sequence, 4812).
NoDuplicateSeq == \A i, j \in ReadIdx : i # j => chat[i].seq # chat[j].seq

\* Every completed append/update survives (torn tails never swallow rows).
NoLostCommittedRow == \A id \in committed : id \in IdsIn(chat)

\* Streamed assistant content stays recoverable from partial.json or chat.jsonl
\* until the user abandons it or an edit discards it.
NoLostStreamedContent ==
  \A id \in streamed \ discarded :
    \/ (partial # NoRec /\ partial.id = id)
    \/ \E i \in ReadIdx : chat[i].id = id /\ chat[i].parts > 0

\* commitPartial never fails on state the protocol itself produced (an Err blocks sends).
NoCommitError == commitErrs = 0

TypeOK ==
  /\ lock \in Backends \cup {NONE}
  /\ partial = NoRec \/ partial.parts \in 1..MaxParts
=============================================================================
