----------------------------- MODULE ArchiveSwap -----------------------------
(***************************************************************************)
(* Crash-consistency model of HistoryService's archive/chat protocols:    *)
(*   - the truncate transaction (marker + archive tombstone rename swap),  *)
(*     rewriteHistoryFilesUnlocked, historyService.ts:1478-1592;           *)
(*   - its recovery, recoverTruncateTransactionUnlocked, 1314-1399;        *)
(*   - sealed-history rotation, rotateSealedHistoryUnlocked, 2839-2926,    *)
(*     and the read-path entry ensureSealedHistoryRotatedUnlocked, 2780;   *)
(*   - O_APPEND appends with torn-tail delimiting                          *)
(*     (historyAppendProvenance.ts:318-333).                               *)
(* Every filesystem call is one atomic step. writeFileAtomic and rename    *)
(* are all-or-nothing; appends can tear on a crash. A crash loses the      *)
(* backend's memory and releases its lock (fileLock.ts reclamation is      *)
(* assumed correct); disk survives. Rows are abstract: id = sequence.      *)
(***************************************************************************)
EXTENDS Integers, Sequences, FiniteSets, TLC

CONSTANTS
  Backends,
  MaxCrashes, MaxAppends, MaxRotations, MaxTruncations,
  RotationRecovers,         \* F5 fix: rotation re-runs truncate recovery in-lock (TRUE = current code)
  MutUnlinkTombstoneFirst,  \* mutation: drop the old archive (tombstone) before writing chat.jsonl
  MutRecoverForwardOnly,    \* mutation: recovery always rolls forward (never restores the tombstone)
  MutNoTornSeparator        \* mutation: appends do not delimit a torn tail

NONE == "none"
NoFile == [ex |-> FALSE, c |-> <<>>]
File(c) == [ex |-> TRUE, c |-> c]
NoMarker == [ex |-> FALSE, fa |-> NoFile, fc |-> <<>>]

VARIABLES
  chat,      \* Seq of lines [id, bnd, torn] (chat.jsonl; always present in this model)
  archive,   \* NoFile or File(lines)            (chat-archive.jsonl)
  tomb,      \* NoFile or File(lines)            (chat-archive.jsonl.truncate)
  marker,    \* NoMarker or [ex, fa, fc]         (truncate transaction marker: final hashes)
  lock,      \* abstract cross-process history write lock
  pc, ret, loc,  \* per-backend program counter, recovery return pc, scratch
  nextId, appends, rotations, truncs, crashes,
  committed, \* ghost: ids whose append completed and that no completed truncation removed
  removed,   \* ghost: ids removed by completed (or rolled-forward) truncations
  crashedTrunc \* ghost: ids a crashed, not yet recovered truncation intended to remove

vars == <<chat, archive, tomb, marker, lock, pc, ret, loc, nextId, appends, rotations, truncs,
          crashes, committed, removed, crashedTrunc>>

Line(id, b) == [id |-> id, bnd |-> b, torn |-> FALSE]
Torn(l) == [l EXCEPT !.torn = TRUE]
RIdx(s) == {i \in 1..Len(s) : ~s[i].torn}
Ids(s) == {s[i].id : i \in RIdx(s)}
SeqMax(s) == IF Ids(s) = {} THEN -1 ELSE CHOOSE m \in Ids(s) : \A x \in Ids(s) : x <= m
Filter(s, R) == SelectSeq(s, LAMBDA l : l.torn \/ l.id \notin R)
Cat(s, t) ==   \* append t to s; historyAppendProvenance.ts:325 / rotation 2903-2906 delimit a torn tail
  IF MutNoTornSeparator /\ Len(s) > 0 /\ s[Len(s)].torn /\ Len(t) > 0
    THEN SubSeq(s, 1, Len(s) - 1) \o <<Torn(t[1])>> \o SubSeq(t, 2, Len(t))
    ELSE s \o t

\* Logical history as seen by full-history readers (archive then chat, duplicates of a
\* crashed rotation collapse: they are healed by the next rotation's dedupe, 2860-2885).
ViewIds(a, c) == Ids(a.c) \cup Ids(c)

\* Pure recovery result (what the next locked operation leaves on disk),
\* mirroring recoverTruncateTransactionUnlocked (1314-1399).
CommittedTxn(a, c, m) == a = m.fa /\ c = m.fc                                  \* 1366-1377
Recover(c, a, t, m) ==
  IF ~m.ex
    THEN IF ~t.ex THEN a ELSE IF a.ex THEN a ELSE t                           \* 1334-1342
    ELSE IF ~t.ex THEN a                                                      \* 1347-1349
    ELSE IF CommittedTxn(a, c, m) \/ MutRecoverForwardOnly THEN a ELSE t      \* 1378-1398
RecoveredIds == ViewIds(Recover(chat, archive, tomb, marker), chat)

Init ==
  /\ chat = <<>> /\ archive = NoFile /\ tomb = NoFile /\ marker = NoMarker
  /\ lock = NONE
  /\ pc = [b \in Backends |-> "idle"] /\ ret = [b \in Backends |-> "idle"]
  /\ loc = [b \in Backends |-> NONE]
  /\ nextId = 0 /\ appends = 0 /\ rotations = 0 /\ truncs = 0 /\ crashes = 0
  /\ committed = {} /\ removed = {} /\ crashedTrunc = {}

Free == lock = NONE
Disk == <<chat, archive, tomb, marker>>
Counters == <<nextId, appends, rotations, truncs, crashes>>
Ghost == <<committed, removed, crashedTrunc>>

---------------------------------------------------------------------------
(* Truncate recovery as a sub-procedure (lock already held). One step per  *)
(* filesystem call; `ret` is where to continue.                            *)
\* Settle the ghost of a crashed truncation once recovery has resolved it.
Settle ==
  IF crashedTrunc = {} THEN UNCHANGED <<committed, removed, crashedTrunc>>
  ELSE IF crashedTrunc \subseteq ViewIds(archive', chat')
    THEN /\ crashedTrunc' = {} /\ UNCHANGED <<committed, removed>>            \* rolled back
    ELSE /\ removed' = removed \cup crashedTrunc
         /\ committed' = committed \ crashedTrunc
         /\ crashedTrunc' = {}                                                \* rolled forward

RecReturn(b) == pc' = [pc EXCEPT ![b] = ret[b]]

RecStep(b) ==
  /\ pc[b] = "rec" /\ lock = b
  /\ IF ~marker.ex /\ ~tomb.ex
       THEN /\ RecReturn(b) /\ UNCHANGED <<chat, archive, tomb, marker>> /\ Settle
     ELSE IF ~marker.ex
       THEN \* 1339 rm tombstone | 1341 rename tombstone -> archive
            /\ archive' = IF archive.ex THEN archive ELSE tomb
            /\ tomb' = NoFile
            /\ RecReturn(b) /\ UNCHANGED <<chat, marker>> /\ Settle
     ELSE IF ~tomb.ex
       THEN \* 1349 rm marker
            /\ marker' = NoMarker
            /\ RecReturn(b) /\ UNCHANGED <<chat, archive, tomb>> /\ Settle
     ELSE IF CommittedTxn(archive, chat, marker) \/ MutRecoverForwardOnly
       THEN \* 1385 rm tombstone
            /\ tomb' = NoFile /\ pc' = [pc EXCEPT ![b] = "rec_f2"]
            /\ UNCHANGED <<chat, archive, marker, committed, removed, crashedTrunc>>
       ELSE \* 1393 rm archive (force)
            /\ archive' = NoFile /\ pc' = [pc EXCEPT ![b] = "rec_b2"]
            /\ UNCHANGED <<chat, tomb, marker, committed, removed, crashedTrunc>>
  /\ UNCHANGED <<lock, ret, loc, Counters>>

RecF2(b) ==   \* 1387 rm marker
  /\ pc[b] = "rec_f2" /\ lock = b
  /\ marker' = NoMarker /\ RecReturn(b) /\ UNCHANGED <<chat, archive, tomb>> /\ Settle
  /\ UNCHANGED <<lock, ret, loc, Counters>>
RecB2(b) ==   \* 1395 rename tombstone -> archive
  /\ pc[b] = "rec_b2" /\ lock = b
  /\ archive' = tomb /\ tomb' = NoFile /\ pc' = [pc EXCEPT ![b] = "rec_b3"]
  /\ UNCHANGED <<chat, marker, lock, ret, loc, Counters, Ghost>>
RecB3(b) ==   \* 1397 rm marker
  /\ pc[b] = "rec_b3" /\ lock = b
  /\ marker' = NoMarker /\ RecReturn(b) /\ UNCHANGED <<chat, archive, tomb>> /\ Settle
  /\ UNCHANGED <<lock, ret, loc, Counters>>

\* Acquire the lock and enter recovery, continuing at `next`.
LockAndRecover(b, next) ==
  /\ Free
  /\ lock' = b
  /\ pc' = [pc EXCEPT ![b] = "rec"]
  /\ ret' = [ret EXCEPT ![b] = next]

---------------------------------------------------------------------------
(* Append: withCrossProcessWriteLock (3603) runs recovery in-lock (3631).  *)
AppendBegin(b) ==
  /\ pc[b] = "idle" /\ appends < MaxAppends
  /\ LockAndRecover(b, "append")
  /\ UNCHANGED <<chat, archive, tomb, marker, loc, Counters, Ghost>>

AppendRow(b) ==
  /\ pc[b] = "append" /\ lock = b
  /\ \E bnd \in BOOLEAN :
       chat' = Cat(chat, <<Line(nextId, bnd)>>)                  \* historyAppendProvenance.ts:333
  /\ committed' = committed \cup {nextId}
  /\ nextId' = nextId + 1 /\ appends' = appends + 1
  /\ lock' = NONE /\ pc' = [pc EXCEPT ![b] = "idle"]
  /\ UNCHANGED <<archive, tomb, marker, ret, loc, rotations, truncs, crashes, removed, crashedTrunc>>

---------------------------------------------------------------------------
(* Read path with lazy rotation: withRecoveredHistoryLock (1454) recovers  *)
(* under the file lock and RELEASES it (1443-1451); later                  *)
(* ensureSealedHistoryRotatedUnlocked (2780) re-acquires the bare lock     *)
(* (2790). RotationRecovers = FALSE rotates WITHOUT truncate recovery    *)
(* (the pre-fix code); TRUE re-runs recovery first (the F5 fix).          *)
ReadBegin(b) ==
  /\ pc[b] = "idle" /\ rotations < MaxRotations
  /\ LockAndRecover(b, "read_unlock")
  /\ UNCHANGED <<chat, archive, tomb, marker, loc, Counters, Ghost>>

ReadUnlock(b) ==
  /\ pc[b] = "read_unlock" /\ lock = b
  /\ lock' = NONE /\ pc' = [pc EXCEPT ![b] = "rot_lock"]
  /\ UNCHANGED <<chat, archive, tomb, marker, ret, loc, Counters, Ghost>>

RotLock(b) ==
  /\ pc[b] = "rot_lock" /\ Free
  /\ lock' = b
  /\ IF RotationRecovers
       THEN pc' = [pc EXCEPT ![b] = "rec"] /\ ret' = [ret EXCEPT ![b] = "rot_plan"]
       ELSE pc' = [pc EXCEPT ![b] = "rot_plan"] /\ UNCHANGED ret
  /\ UNCHANGED <<chat, archive, tomb, marker, loc, Counters, Ghost>>

LastBnd(s) == LET B == {i \in RIdx(s) : s[i].bnd} IN
              IF B = {} THEN 0 ELSE CHOOSE i \in B : \A j \in B : j <= i

\* 2847-2888: sealed prefix, crash-replay dedupe (sequence-covered AND byte-identical copies).
RotPlan(b) ==
  /\ pc[b] = "rot_plan" /\ lock = b
  /\ LET k == LastBnd(chat) IN
     IF k <= 1
       THEN /\ lock' = NONE /\ pc' = [pc EXCEPT ![b] = "idle"]
            /\ rotations' = rotations + 1
            /\ UNCHANGED loc
       ELSE LET prefix == SubSeq(chat, 1, k - 1)
                amax == SeqMax(archive.c)
                arch == {archive.c[i] : i \in 1..Len(archive.c)}
                keep == SelectSeq(prefix, LAMBDA l : l.torn \/ l.id > amax \/ l \notin arch)
            IN /\ loc' = [loc EXCEPT ![b] = [lines |-> keep, tail |-> SubSeq(chat, k, Len(chat))]]
               /\ pc' = [pc EXCEPT ![b] = IF Len(keep) > 0 THEN "rot_append" ELSE "rot_chat"]
               /\ UNCHANGED <<lock, rotations>>
  /\ UNCHANGED <<chat, archive, tomb, marker, ret, nextId, appends, truncs, crashes, Ghost>>

\* 2895 fs.open(archive, "a+") creates the archive if absent; 2903-2911 delimit + write + fsync.
RotAppend(b) ==
  /\ pc[b] = "rot_append" /\ lock = b
  /\ archive' = File(Cat(archive.c, loc[b].lines))
  /\ pc' = [pc EXCEPT ![b] = "rot_chat"]
  /\ UNCHANGED <<chat, tomb, marker, lock, ret, loc, Counters, Ghost>>

\* 2919 writeFileAtomic(chat, activeTail)
RotChat(b) ==
  /\ pc[b] = "rot_chat" /\ lock = b
  /\ chat' = loc[b].tail
  /\ lock' = NONE /\ pc' = [pc EXCEPT ![b] = "idle"] /\ loc' = [loc EXCEPT ![b] = NONE]
  /\ rotations' = rotations + 1
  /\ UNCHANGED <<archive, tomb, marker, ret, nextId, appends, truncs, crashes, Ghost>>

---------------------------------------------------------------------------
(* truncateHistory (5695) -> rewriteHistoryFilesUnlocked (1478), under     *)
(* withRecoveredHistoryWriteResultLock (in-lock recovery first).           *)
TruncBegin(b) ==
  /\ pc[b] = "idle" /\ truncs < MaxTruncations
  /\ LockAndRecover(b, "trunc_plan")
  /\ UNCHANGED <<chat, archive, tomb, marker, loc, Counters, Ghost>>

\* Remove the oldest k logical rows (5815-5833): archive rows first, then chat rows.
TruncPlan(b) ==
  /\ pc[b] = "trunc_plan" /\ lock = b
  /\ LET all == ViewIds(archive, chat) IN
     \E R \in SUBSET all :
       /\ R # {}
       /\ \A x \in R, y \in all \ R : x < y            \* a prefix by sequence
       /\ LET fa == IF archive.ex /\ Len(Filter(archive.c, R)) > 0 THEN File(Filter(archive.c, R)) ELSE NoFile
              fc == Filter(chat, R)
          IN loc' = [loc EXCEPT ![b] = [R |-> R, fa |-> fa, fc |-> fc]]
  /\ pc' = [pc EXCEPT ![b] = IF archive.ex THEN "t_marker" ELSE "t_chat_only"]
  /\ UNCHANGED <<chat, archive, tomb, marker, lock, ret, Counters, Ghost>>

TruncDone(b) ==
  /\ lock' = NONE /\ pc' = [pc EXCEPT ![b] = "idle"] /\ loc' = [loc EXCEPT ![b] = NONE]
  /\ truncs' = truncs + 1
  /\ removed' = removed \cup loc[b].R /\ committed' = committed \ loc[b].R

\* 1497-1517: no archive -> single atomic chat publication.
TChatOnly(b) ==
  /\ pc[b] = "t_chat_only" /\ lock = b
  /\ chat' = loc[b].fc
  /\ TruncDone(b)
  /\ UNCHANGED <<archive, tomb, marker, ret, nextId, appends, rotations, crashes, crashedTrunc>>

TStep(b, from, to, dChat, dArchive, dTomb, dMarker) ==
  /\ pc[b] = from /\ lock = b
  /\ chat' = dChat /\ archive' = dArchive /\ tomb' = dTomb /\ marker' = dMarker
  /\ pc' = [pc EXCEPT ![b] = to]
  /\ UNCHANGED <<lock, ret, loc, Counters, Ghost>>

TMarker(b) ==   \* 1550 writeFileAtomic(marker)
  TStep(b, "t_marker", "t_rename", chat, archive, tomb,
        [ex |-> TRUE, fa |-> loc[b].fa, fc |-> loc[b].fc])
TRename(b) ==   \* 1552 rename(archive, archive.truncate)
  TStep(b, "t_rename", "t_archive", chat, NoFile, archive, marker)
TArchive(b) ==  \* 1560 writeFileAtomic(archive, final) when non-null
  TStep(b, "t_archive", IF MutUnlinkTombstoneFirst THEN "t_rmtomb" ELSE "t_chat",
        chat, IF loc[b].fa.ex THEN loc[b].fa ELSE archive, tomb, marker)
TChat(b) ==     \* 1565 writeFileAtomic(chat, final)
  TStep(b, "t_chat", IF MutUnlinkTombstoneFirst THEN "t_rmmarker" ELSE "t_rmtomb",
        loc[b].fc, archive, tomb, marker)
TRmTomb(b) ==   \* 1584 rm tombstone
  TStep(b, "t_rmtomb", IF MutUnlinkTombstoneFirst THEN "t_chat" ELSE "t_rmmarker",
        chat, archive, NoFile, marker)
TRmMarker(b) == \* 1585 rm marker
  /\ pc[b] = "t_rmmarker" /\ lock = b
  /\ marker' = NoMarker
  /\ TruncDone(b)
  /\ UNCHANGED <<chat, archive, tomb, ret, nextId, appends, rotations, crashes, crashedTrunc>>

---------------------------------------------------------------------------
TruncPcs == {"t_marker", "t_rename", "t_archive", "t_chat", "t_rmtomb", "t_rmmarker"}

CrashCore(b) ==
  /\ crashes < MaxCrashes /\ pc[b] # "idle"
  /\ pc' = [pc EXCEPT ![b] = "idle"] /\ loc' = [loc EXCEPT ![b] = NONE]
  /\ lock' = IF lock = b THEN NONE ELSE lock
  /\ crashes' = crashes + 1
  /\ crashedTrunc' = IF pc[b] \in TruncPcs THEN crashedTrunc \cup loc[b].R ELSE crashedTrunc
  /\ UNCHANGED <<ret, nextId, appends, rotations, truncs, committed, removed>>

Crash(b) == CrashCore(b) /\ UNCHANGED Disk

\* Crash in the middle of an append: the new bytes tear.
TornAppendCrash(b) ==
  /\ pc[b] = "append" /\ lock = b
  /\ chat' = Cat(chat, <<Torn(Line(nextId, FALSE))>>)
  /\ CrashCore(b)
  /\ UNCHANGED <<archive, tomb, marker>>
TornRotationCrash(b) ==
  /\ pc[b] = "rot_append" /\ lock = b
  /\ \E n \in 0..(Len(loc[b].lines) - 1) :
       archive' = File(Cat(archive.c, SubSeq(loc[b].lines, 1, n) \o <<Torn(loc[b].lines[n + 1])>>))
  /\ CrashCore(b)
  /\ UNCHANGED <<chat, tomb, marker>>

Next ==
  \E b \in Backends :
    \/ RecStep(b) \/ RecF2(b) \/ RecB2(b) \/ RecB3(b)
    \/ AppendBegin(b) \/ AppendRow(b)
    \/ ReadBegin(b) \/ ReadUnlock(b) \/ RotLock(b) \/ RotPlan(b) \/ RotAppend(b) \/ RotChat(b)
    \/ TruncBegin(b) \/ TruncPlan(b) \/ TChatOnly(b)
    \/ TMarker(b) \/ TRename(b) \/ TArchive(b) \/ TChat(b) \/ TRmTomb(b) \/ TRmMarker(b)
    \/ Crash(b) \/ TornAppendCrash(b) \/ TornRotationCrash(b)

Spec == Init /\ [][Next]_vars

---------------------------------------------------------------------------
(* Invariants, evaluated on the state the next recovery would produce.     *)
InFlightTrunc == UNION {IF pc[b] \in TruncPcs THEN loc[b].R ELSE {} : b \in Backends}

\* No committed row is lost (except rows an in-flight/crashed truncation removes).
NoLostRow == committed \ (InFlightTrunc \cup crashedTrunc) \subseteq RecoveredIds

\* A completed truncation is never undone.
NoResurrectedRow == removed \cap RecoveredIds = {}

\* A crashed truncation recovers all-or-nothing.
TruncationAtomic ==
  \A R \in {crashedTrunc} : R \cap RecoveredIds = {} \/ R \subseteq RecoveredIds

TypeOK == lock \in Backends \cup {NONE}
=============================================================================
