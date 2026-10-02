---------------------------- MODULE ComposerSends ----------------------------
(***************************************************************************)
(* Idempotent sends for one workspace composer: design for D2, D4, D5, H1 *)
(* (ComposerDrafts.tla models the rest of the composer).                   *)
(*                                                                         *)
(* FixIds (the design):                                                    *)
(*  - every send carries an id; every retry reuses it with the same        *)
(*    payload. An item is a text token or an attachment-only input.        *)
(*  - acceptance is the in-lock append of the user row that carries the    *)
(*    ids (metadata.sendIds). The admission checks run inside the same     *)
(*    lock, so a written row is never rolled back: a row on disk is the    *)
(*    only acceptance evidence. The in-lock check refuses an id that a row *)
(*    already carries (a different payload under it is a conflict).        *)
(*  - send: ONE draft write keeps the item as retained text in the legacy *)
(*    fields (PR #5483: text = joinDraftText(retained, view), the composer *)
(*    hides it) plus persisted pendingSends bookkeeping (id, receiver,     *)
(*    the retained text). Removal is anchored at the retained prefix by id,*)
(*    not searched by text. The composer stays in its sending state while  *)
(*    an entry is unresolved.                                              *)
(*  - lookup (atomic with the draft write, under the draft lock):          *)
(*      a row has the id                -> accepted: drop the chunk         *)
(*      asked of the receiver: in flight, queued or held -> pending;       *)
(*        otherwise the receiver remembers the id as refused (process      *)
(*        memory, never evicted) -> not accepted: chunk becomes visible     *)
(*      asked of another backend: receiver alive -> unknown (keep);        *)
(*        receiver restarted -> not accepted (its requests died with it)   *)
(*  - a request in transit dies when its receiver restarts.                *)
(*  - queue: an id already queued, in flight or held is not queued again;  *)
(*    a batch appends only its ids that no row carries yet.                *)
(*  - a writer that does not know the bookkeeping (an older build) keeps   *)
(*    the legacy fields; the retained prefix then no longer matches the    *)
(*    bookkeeping, which is dropped: the text stays as visible content.    *)
(* FixIds = FALSE is the code today: no ids, the send clears the draft     *)
(* (an explicit flush saves the clear), a failure restores the input, and  *)
(* a row can be rolled back after it was written.                          *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
  Items,            \* inputs the user creates, each once
  AttachOnly,       \* items that are attachment-only (no text)
  TwoBackends,      \* a second backend instance on the same workspace (window w2 uses it)
  TwoWindows,
  WithQueue,        \* busy session: sends are queued; batches; dequeue refusal holds
  WithRollback,     \* FixIds = FALSE only: a written row can be rolled back
  WithRestart, WithOtherWriter, WithDowngrade,
  FixIds,
  MutRollbackAfterAppend, \* FixIds keeps the code's post-append rollback
  MutNoRefusalMemory,     \* the receiver answers "not accepted" without remembering it
  MutDeadIsAccepted,      \* a restarted receiver is read as "accepted"
  MutNoDedupe,            \* the in-lock check ignores ids
  MutBookOnly,            \* pending content only in the bookkeeping (not the legacy fields)
  MutEmptyRule,           \* "empty draft" ignores pending attachments (file deleted)
  MutConflictAccept,      \* a different payload under a known id is appended
  DowngradeSettledOnly    \* downgrade only when no accepted chunk awaits removal (the stated limit)

Backends == IF TwoBackends THEN {"b1", "b2"} ELSE {"b1"}
Windows == IF TwoWindows THEN {"w1", "w2"} ELSE {"w1"}
BackOf(w) == IF w = "w2" /\ TwoBackends THEN "b2" ELSE "b1"
Ks == {1, 2}
Ids == Items \X Ks          \* <<item, k>>: k = 2 is a fresh send of released content
Epochs == 0..2

VARIABLES
  typed,     \* ghost
  vis,       \* visible draft content (durable legacy fields)
  block,     \* ids whose item sits in the pending block of the legacy fields (durable)
  book,      \* pendingSends: id -> <<receiver, its epoch at send>> (durable; older builds drop it)
  nsent,     \* fresh ids used per item
  req,       \* requests: <<id, item, receiver, its epoch, registered?, kind>> (kind keeps copies apart)
  queue,     \* per backend: the queued batch, a set of <<id, item>> (memory)
  held,      \* held inputs: <<id, item, backend>>
  rows,      \* transcript rows: <<id-set, item-set, source>> (source keeps copies apart)
  prov,      \* rows that can still be rolled back (FixIds = FALSE or the mutant)
  refused,   \* receiver memory: ids answered "not accepted" (per backend, process lifetime)
  epoch,     \* restarts per backend
  dropped,   \* ghost: items the user discarded
  old        \* running an older build

vars == <<typed, vis, block, book, nsent, req, queue, held, rows, prov, refused, epoch, dropped, old>>

RowIds == UNION {r[1] : r \in rows}
RowItems(i) == Cardinality({r \in rows : i \in r[2]})   \* a row per item at most once is NoDup
Tok(S) == {x[1] : x \in S}
Rolls == FixIds = FALSE \/ MutRollbackAfterAppend

TypeOK ==
  /\ typed \subseteq Items /\ vis \subseteq Items /\ block \subseteq Ids
  /\ DOMAIN book \subseteq Ids /\ \A x \in DOMAIN book : book[x] \in Backends \X Epochs
  /\ nsent \in [Items -> 0..2] /\ held \subseteq Ids \X Items \X Backends
  /\ epoch \in [Backends -> Epochs] /\ refused \in [Backends -> SUBSET Ids]
  /\ dropped \subseteq Items /\ old \in BOOLEAN

Init ==
  /\ typed = {} /\ vis = {} /\ block = {} /\ book = <<>> /\ nsent = [i \in Items |-> 0]
  /\ req = {} /\ queue = [b \in Backends |-> {}] /\ held = {} /\ rows = {} /\ prov = {}
  /\ refused = [b \in Backends |-> {}] /\ epoch = [b \in Backends |-> 0] /\ dropped = {} /\ old = FALSE

Drop(f, x) == [k \in DOMAIN f \ {x} |-> f[k]]
Add(f, x, v) == [k \in DOMAIN f \cup {x} |-> IF k = x THEN v ELSE f[k]]
\* The receiver of entry id restarted since the send (an epoch names one process lifetime).
RcvRestarted(id) == epoch[book[id][1]] > book[id][2]

-----------------------------------------------------------------------------
(* Renderer                                                                *)

Create(i) ==
  /\ ~old /\ i \notin typed
  /\ typed' = typed \cup {i} /\ vis' = vis \cup {i}
  /\ UNCHANGED <<block, book, nsent, req, queue, held, rows, prov, refused, epoch, dropped, old>>

\* One draft write: the item leaves the visible part and enters the pending block plus bookkeeping.
\* MutEmptyRule: an attachment-only pending block counts as empty and the draft file is deleted.
Send(w, i) ==
  /\ ~old /\ i \in vis /\ nsent[i] < 2
  /\ LET id == <<i, nsent[i] + 1>>  b == BackOf(w) IN
     /\ vis' = vis \ {i}
     /\ block' = IF FixIds /\ ~MutBookOnly /\ ~(MutEmptyRule /\ i \in AttachOnly) THEN block \cup {id} ELSE block
     /\ book' = IF FixIds /\ ~(MutEmptyRule /\ i \in AttachOnly) THEN Add(book, id, <<b, epoch[b]>>) ELSE book
     /\ req' = req \cup {<<id, i, b, epoch[b], FALSE, "send">>}
  /\ nsent' = [nsent EXCEPT ![i] = @ + 1]
  /\ UNCHANGED <<typed, queue, held, rows, prov, refused, epoch, dropped, old>>

\* Today: a failed or lost reply restores the input into the composer (FixIds: nothing happens;
\* the entry is resolved by Lookup).
ReplyLost(r) ==
  /\ ~FixIds /\ ~old /\ r \in req /\ r[1][1] \notin vis
  /\ vis' = vis \cup {r[1][1]}
  /\ UNCHANGED <<typed, block, book, nsent, req, queue, held, rows, prov, refused, epoch, dropped, old>>

\* Running, queued or held at receiver b: what that process knows (a request still in transit is
\* not known to anyone).
AtReceiver(id, b) ==
  \/ \E r \in req : r[1] = id /\ r[3] = b /\ r[4] = epoch[b] /\ r[5]
  \/ id \in Tok(queue[b])
  \/ \E h \in held : h[1] = id /\ h[3] = b

\* Lookup and reconcile of one entry (draft lock), from window w.
Lookup(w, id) ==
  /\ FixIds /\ ~old /\ id \in DOMAIN book
  /\ LET via == BackOf(w)  rcv == book[id][1]
         acc == id \in RowIds
     IN \/ /\ acc                                                   \* accepted
           /\ book' = Drop(book, id) /\ block' = block \ {id}
           /\ UNCHANGED <<vis, refused>>
        \/ /\ ~acc /\ via = rcv /\ ~AtReceiver(id, rcv)                \* not accepted, remembered
           /\ refused' = IF MutNoRefusalMemory THEN refused ELSE [refused EXCEPT ![rcv] = @ \cup {id}]
           /\ book' = Drop(book, id) /\ block' = block \ {id} /\ vis' = vis \cup {id[1]}
  /\ UNCHANGED <<typed, nsent, req, queue, held, rows, prov, epoch, dropped, old>>

\* Lookup through a backend that is not the receiver, after the receiver restarted: the requests
\* it had died with it. (While the receiver lives, the answer is unknown: nothing happens.)
LookupAfterRestart(w, id) ==
  /\ FixIds /\ ~old /\ id \in DOMAIN book /\ id \notin RowIds
  /\ BackOf(w) # book[id][1] /\ RcvRestarted(id)
  /\ IF MutDeadIsAccepted
       THEN book' = Drop(book, id) /\ block' = block \ {id} /\ UNCHANGED vis
       ELSE book' = Drop(book, id) /\ block' = block \ {id} /\ vis' = vis \cup {id[1]}
  /\ UNCHANGED <<typed, nsent, req, queue, held, rows, prov, refused, epoch, dropped, old>>

\* A retry of an entry (same id, same payload), e.g. after a lost reply. The client cannot see
\* whether an earlier copy is still on its way.
Retry(w, id) ==
  /\ FixIds /\ ~old /\ id \in DOMAIN book /\ BackOf(w) = book[id][1]
  \* The bookkeeping names the receiver process of the latest attempt (draft write first).
  /\ book' = Add(book, id, <<book[id][1], epoch[book[id][1]]>>)
  /\ ~\E r \in req : r[1] = id /\ r[6] = "retry"
  /\ req' = req \cup {<<id, id[1], book[id][1], epoch[book[id][1]], FALSE, "retry">>}
  /\ UNCHANGED <<typed, vis, block, nsent, queue, held, rows, prov, refused, epoch, dropped, old>>

\* A buggy or racing client reuses an id for a different item.
ConflictSend(w, id, j) ==
  /\ FixIds /\ ~old /\ id \in RowIds /\ j \in vis /\ j # id[1]
  \* (Its content stays in the draft: this action only exercises the backend's id check.)
  /\ req' = req \cup {<<id, j, BackOf(w), epoch[BackOf(w)], FALSE, "conflict">>}
  /\ UNCHANGED <<typed, vis, block, book, nsent, queue, held, rows, prov, refused, epoch, dropped, old>>

-----------------------------------------------------------------------------
(* Backend                                                                 *)

\* Handler entry: a request reaches its receiver only in the lifetime it was sent to; an id the
\* receiver answered "not accepted" is refused (late arrival).
Register(r) ==
  /\ ~old /\ r \in req /\ ~r[5] /\ r[4] = epoch[r[3]]
  /\ IF FixIds /\ r[1] \in refused[r[3]]
       THEN req' = req \ {r}
       ELSE req' = (req \ {r}) \cup {<<r[1], r[2], r[3], r[4], TRUE, r[6]>>}
  /\ UNCHANGED <<typed, vis, block, book, nsent, queue, held, rows, prov, refused, epoch, dropped, old>>

DropHeld(id) == {h \in held : h[1] # id}

\* In-lock append of a direct send or a held Retry (idle session).
Append(r) ==
  /\ ~old /\ r \in req /\ r[5]
  /\ req' = req \ {r}
  /\ LET id == r[1]  i == r[2]  known == FixIds /\ ~MutNoDedupe /\ id \in RowIds
         same == \E row \in rows : id \in row[1] /\ i \in row[2]
     IN IF known /\ (same \/ ~MutConflictAccept)
          THEN \* already accepted (same payload) or conflict (no row; the conflicting content
               \* never left the draft, see ConflictSend)
               /\ held' = DropHeld(id)
               /\ UNCHANGED <<vis, rows, prov>>
          ELSE /\ rows' = rows \cup {<<{id}, {i}, r[6]>>}
               /\ prov' = IF Rolls THEN prov \cup {<<{id}, {i}, r[6]>>} ELSE prov
               /\ held' = DropHeld(id)
               /\ UNCHANGED vis
  /\ UNCHANGED <<typed, block, book, nsent, queue, refused, epoch, dropped, old>>

\* Busy session: the registered request is queued (an id already queued, held or written is
\* answered "in progress / accepted" instead).
Enqueue(r) ==
  /\ WithQueue /\ ~old /\ r \in req /\ r[5]
  /\ req' = req \ {r}
  /\ IF FixIds /\ ~MutNoDedupe /\ (r[1] \in Tok(queue[r[3]]) \/ r[1] \in RowIds \/ \E h \in held : h[1] = r[1])
       THEN UNCHANGED queue
       ELSE queue' = [queue EXCEPT ![r[3]] = @ \cup {<<r[1], r[2]>>}]
  /\ UNCHANGED <<typed, vis, block, book, nsent, held, rows, prov, refused, epoch, dropped, old>>

\* The batch becomes one row with every id; ids a row already carries are skipped.
Dispatch(b) ==
  /\ WithQueue /\ ~old /\ queue[b] # {}
  /\ LET keep == {p \in queue[b] : ~(FixIds /\ ~MutNoDedupe) \/ p[1] \notin RowIds} IN
     /\ rows' = IF keep # {} THEN rows \cup {<<Tok(keep), {p[2] : p \in keep}, "batch">>} ELSE rows
     /\ prov' = IF keep # {} /\ Rolls THEN prov \cup {<<Tok(keep), {p[2] : p \in keep}, "batch">>} ELSE prov
  /\ queue' = [queue EXCEPT ![b] = {}]
  /\ UNCHANGED <<typed, vis, block, book, nsent, req, held, refused, epoch, dropped, old>>

\* Dequeue refusal: the batch is held (FixIds: entries whose id a row carries are not held).
Hold(b) ==
  /\ WithQueue /\ ~old /\ queue[b] # {}
  /\ held' = held \cup {<<p[1], p[2], b>> : p \in {x \in queue[b] : ~FixIds \/ x[1] \notin RowIds}}
  /\ queue' = [queue EXCEPT ![b] = {}]
  /\ UNCHANGED <<typed, vis, block, book, nsent, req, rows, prov, refused, epoch, dropped, old>>

HeldRetry(h) ==
  /\ ~old /\ h \in held /\ ~\E r \in req : r[1] = h[1]
  /\ req' = req \cup {<<h[1], h[2], h[3], epoch[h[3]], TRUE, "held">>}
  /\ UNCHANGED <<typed, vis, block, book, nsent, queue, held, rows, prov, refused, epoch, dropped, old>>

HeldDiscard(h) ==
  /\ ~old /\ h \in held /\ ~\E r \in req : r[1] = h[1]
  /\ held' = held \ {h} /\ dropped' = dropped \cup {h[2]}
  /\ UNCHANGED <<typed, vis, block, book, nsent, req, queue, rows, prov, refused, epoch, old>>

\* A written row that can still go: committed, or rolled back (the caller then gets Err: today the
\* composer restores the input; a held Retry keeps its held entry).
Commit(row) ==
  /\ row \in prov /\ prov' = prov \ {row}
  /\ UNCHANGED <<typed, vis, block, book, nsent, req, queue, held, rows, refused, epoch, dropped, old>>
Rollback(row) ==
  /\ (WithRollback \/ MutRollbackAfterAppend) /\ ~old /\ row \in prov
  /\ prov' = prov \ {row} /\ rows' = rows \ {row}
  /\ vis' = IF FixIds THEN vis ELSE vis \cup row[2]
  /\ UNCHANGED <<typed, block, book, nsent, req, queue, held, refused, epoch, dropped, old>>
\* Today: a refusal after the row became durable (rollback failed): Err; the composer restores
\* the input and a held entry stays (D2 without transport, H1).
ErrDurable(row) ==
  /\ ~FixIds /\ WithRollback /\ ~old /\ row \in prov
  /\ prov' = prov \ {row} /\ vis' = vis \cup row[2]
  /\ UNCHANGED <<typed, block, book, nsent, req, queue, held, rows, refused, epoch, dropped, old>>

\* Crash or restart of backend b: its requests (in transit or running), queue and memory go;
\* written rows stay. Quitting with held input is blocked (restart blocker), so none is held.
Restart(b) ==
  /\ WithRestart /\ ~old /\ epoch[b] < 2 /\ ~\E h \in held : h[3] = b
  /\ epoch' = [epoch EXCEPT ![b] = @ + 1]
  /\ req' = {r \in req : r[3] # b} /\ queue' = [queue EXCEPT ![b] = {}]
  /\ refused' = [refused EXCEPT ![b] = {}] /\ prov' = {}
  /\ UNCHANGED <<typed, vis, block, book, nsent, held, rows, dropped, old>>

\* Restart into an older build (every backend), a write by it, and the upgrade back.
Downgrade ==
  /\ WithDowngrade /\ ~old /\ held = {} /\ \A b \in Backends : epoch[b] < 2
  /\ DowngradeSettledOnly => \A id \in DOMAIN book : id \notin RowIds
  /\ old' = TRUE /\ epoch' = [b \in Backends |-> epoch[b] + 1]
  /\ req' = {} /\ queue' = [b \in Backends |-> {}] /\ refused' = [b \in Backends |-> {}] /\ prov' = {}
  /\ UNCHANGED <<typed, vis, block, book, nsent, held, rows, dropped>>
\* An older build (or any writer that does not know pendingSends) writes the draft: it keeps the
\* legacy fields, so the pending block is plain visible content now; the bookkeeping is gone (the
\* digest no longer matches when a new build reads it).
OldWrite ==
  /\ (old \/ WithOtherWriter) /\ (DOMAIN book # {} \/ block # {})
  /\ vis' = vis \cup Tok(block) /\ block' = {} /\ book' = <<>>
  /\ UNCHANGED <<typed, nsent, req, queue, held, rows, prov, refused, epoch, dropped, old>>
Upgrade ==
  /\ old /\ old' = FALSE
  /\ UNCHANGED <<typed, vis, block, book, nsent, req, queue, held, rows, prov, refused, epoch, dropped>>

Next ==
  \/ \E i \in Items : Create(i)
  \/ \E w \in Windows, i \in Items : Send(w, i)
  \/ \E r \in req : ReplyLost(r) \/ Register(r) \/ Append(r) \/ Enqueue(r)
  \/ \E w \in Windows, id \in Ids : Lookup(w, id) \/ LookupAfterRestart(w, id) \/ Retry(w, id)
  \/ \E w \in Windows, id \in Ids, j \in Items : ConflictSend(w, id, j)
  \/ \E b \in Backends : Dispatch(b) \/ Hold(b) \/ Restart(b)
  \/ \E h \in held : HeldRetry(h) \/ HeldDiscard(h)
  \/ \E row \in prov : Commit(row) \/ Rollback(row) \/ ErrDurable(row)
  \/ Downgrade \/ OldWrite \/ Upgrade

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
Safe == vis \cup Tok(block) \cup Tok(DOMAIN book) \cup UNION {row[2] : row \in rows}
        \cup {r[2] : r \in req} \cup UNION {{p[2] : p \in queue[b]} : b \in Backends} \cup {h[2] : h \in held}

\* Content the user created is never silently lost.
NoSilentLoss == \A i \in typed : i \in Safe \/ i \in dropped

\* No item reaches the transcript twice, and no id is on two rows.
NoDup == /\ \A i \in Items : RowItems(i) <= 1
         /\ \A id \in Ids : Cardinality({row \in rows : id \in row[1]}) <= 1

\* Settled: nothing in flight or queued, no row can still go, and no accepted entry is waiting for
\* its lookup.
Settled ==
  /\ req = {} /\ prov = {} /\ \A b \in Backends : queue[b] = {}
  /\ \A id \in DOMAIN book : id \notin RowIds

\* The held list hides entries whose id a row carries.
Offered == {h[2] : h \in {x \in held : ~FixIds \/ x[1] \notin RowIds}}

\* Once settled, accepted content is not offered again (visible draft or held list).
NoResurrection == Settled => \A i \in Items : RowItems(i) > 0 => i \notin vis \cup Offered
=============================================================================
