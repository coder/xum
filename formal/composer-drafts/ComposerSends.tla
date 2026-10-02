---------------------------- MODULE ComposerSends ----------------------------
(***************************************************************************)
(* Idempotent sends for one workspace composer (design for D2, D4, D5,     *)
(* H1; ComposerDrafts.tla models the rest of the composer).                *)
(*                                                                         *)
(* FixIds (the design):                                                    *)
(*  - every send has an id; a repeat reuses it. Text is a token, its id is *)
(*    <<token, k>> (k = 2 is a fresh send of released text).               *)
(*  - send: ONE draft write moves the text from the visible part into a    *)
(*    pending block (span) that stays in the legacy `text` field, plus     *)
(*    pendingSends bookkeeping (book: id -> chunk). Older builds keep the  *)
(*    text and drop the bookkeeping.                                       *)
(*  - send ledger (durable, written under the history write lock): append  *)
(*    writes "appended", commit writes "accepted", rollback writes         *)
(*    "fenced", Abandon writes "fenced" when nothing is there yet, held    *)
(*    Discard writes "dropped". The in-lock check refuses an append when   *)
(*    the id has any ledger entry, so every repeated id is deduplicated at *)
(*    the acceptance boundary.                                             *)
(*  - a pending entry is reconciled atomically under the draft lock (any   *)
(*    window, the backend after a commit, a reload): accepted -> remove   *)
(*    chunk; fenced -> chunk becomes visible text; dropped -> remove;      *)
(*    appended/held/registered -> pending, unknown -> keep (no proof).     *)
(*  - restart: an "appended" entry of a dead process is resolved accepted *)
(*    (its row is in the transcript).                                      *)
(* FixIds = FALSE is the code today: the send clears the draft (an         *)
(* explicit flush saves the clear), a failure restores the text, no ids.  *)
(* Mutants: each drops one element of the design.                          *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
  Msgs,             \* tokens the user types, each once
  TwoBackends,      \* a second backend instance serves the same workspace
  TwoWindows,       \* a second renderer window (window w2 talks to backend b2 when there is one)
  WithHeld,         \* dequeue refusal holds a send; Retry / Discard
  RollbackPossible, \* an appended row can be rolled back (stale admission)
  RollbackFail,     \* the refusal cannot roll back: row stays, caller gets Err
  WithRestart, WithDowngrade,
  FixIds,
  MutProvAccepted,  \* lookup reads an appended (uncommitted) row as accepted
  MutUnknownRejects,\* lookup reads unknown as rejected and releases the text
  MutNoDedupe,      \* the in-lock check ignores the ledger
  MutPendingOnly,   \* the pending text lives only in the bookkeeping
  MutRenderReconcile\* reconcile is read-then-write from the renderer

Backends == IF TwoBackends THEN {"b1", "b2"} ELSE {"b1"}
Windows == IF TwoWindows THEN {"w1", "w2"} ELSE {"w1"}
BackOf(w) == IF w = "w2" /\ TwoBackends THEN "b2" ELSE "b1"

Ks == {1, 2}
Ids == Msgs \X Ks
Tok(S) == {i[1] : i \in S}
Reqs == [id : Ids, at : Backends \cup {"net"}, to : Backends, kind : {"send", "held"}]
Apps == [id : Ids, b : Backends, kind : {"send", "held"}]

VARIABLES
  typed,    \* ghost
  vis,      \* visible draft text (durable; the composer shows it)
  span,     \* ids whose chunk sits in the pending block of draft `text` (durable, legacy-readable)
  book,     \* pendingSends bookkeeping (durable; an older build drops it)
  nsent,    \* sends started per token
  req,      \* requests in flight (memory); at = "net" until the backend registers it
  wait,     \* ids whose reply a renderer still awaits (memory)
  appended, \* rows appended, not committed (rollback-eligible)
  rows,     \* transcript rows per token
  ledger,   \* send ledger (durable)
  held,     \* held inputs <<id, backend>> (memory)
  dropped,  \* ghost: tokens the user discarded
  snap,     \* MutRenderReconcile: a window's reconcile snapshot
  old       \* downgraded to an older build

vars == <<typed, vis, span, book, nsent, req, wait, appended, rows, ledger, held, dropped, snap, old>>

NoSnap == <<"none">>

TypeOK ==
  /\ typed \subseteq Msgs /\ vis \subseteq Msgs /\ span \subseteq Ids /\ book \subseteq Ids
  /\ nsent \in [Msgs -> 0..2] /\ req \subseteq Reqs /\ wait \subseteq Ids
  /\ appended \subseteq Apps /\ rows \in [Msgs -> 0..2]
  /\ ledger \in [Ids -> {"none", "appended", "accepted", "fenced", "dropped"}]
  /\ held \subseteq Ids \X Backends /\ dropped \subseteq Msgs /\ old \in BOOLEAN

Init ==
  /\ typed = {} /\ vis = {} /\ span = {} /\ book = {} /\ nsent = [m \in Msgs |-> 0]
  /\ req = {} /\ wait = {} /\ appended = {} /\ rows = [m \in Msgs |-> 0]
  /\ ledger = [i \in Ids |-> "none"] /\ held = {} /\ dropped = {}
  /\ snap = [w \in Windows |-> NoSnap] /\ old = FALSE

Inc(f, m) == [f EXCEPT ![m] = IF @ < 2 THEN @ + 1 ELSE @]
Busy(id) == (\E r \in req : r.id = id) \/ (\E a \in appended : a.id = id)

\* What a lookup through backend b answers.
Status(id, b) ==
  CASE ledger[id] = "accepted" -> "accepted"
    [] ledger[id] = "fenced" -> "fenced"
    [] ledger[id] = "dropped" -> "dropped"
    [] ledger[id] = "appended" -> IF MutProvAccepted THEN "accepted" ELSE "pending"
    [] (\E r \in req : r.id = id /\ r.at = b) \/ <<id, b>> \in held -> "pending"
    [] OTHER -> IF MutUnknownRejects THEN "fenced" ELSE "unknown"

\* The reconcile outcome on (visible, span, book) for entry id with status s.
RVis(v, id, s) == IF s = "fenced" THEN v \cup {id[1]} ELSE v
RDone(s) == s \in {"accepted", "fenced", "dropped"}

-----------------------------------------------------------------------------
(* Renderer                                                                *)

Type(m) ==
  /\ ~old /\ m \notin typed
  /\ typed' = typed \cup {m} /\ vis' = vis \cup {m}
  /\ UNCHANGED <<span, book, nsent, req, wait, appended, rows, ledger, held, dropped, snap, old>>

Send(m, b) ==
  /\ ~old /\ m \in vis /\ nsent[m] < 2
  /\ LET id == <<m, nsent[m] + 1>> IN
     /\ vis' = vis \ {m}
     /\ span' = IF FixIds /\ ~MutPendingOnly THEN span \cup {id} ELSE span
     /\ book' = IF FixIds THEN book \cup {id} ELSE book
     /\ req' = req \cup {[id |-> id, at |-> "net", to |-> b, kind |-> "send"]}
     /\ wait' = wait \cup {id}
  /\ nsent' = [nsent EXCEPT ![m] = @ + 1]
  /\ UNCHANGED <<typed, appended, rows, ledger, held, dropped, snap, old>>

\* Today's failure handling: the composer restores the text (Err reply or lost reply).
Restore(id) == IF FixIds THEN vis ELSE vis \cup {id[1]}

\* The reply is lost (transport error); the request may still be accepted later.
ReplyLost(id) ==
  /\ ~old /\ id \in wait
  /\ wait' = wait \ {id} /\ vis' = Restore(id)
  /\ UNCHANGED <<typed, span, book, nsent, req, appended, rows, ledger, held, dropped, snap, old>>

\* Atomic reconcile of one pending entry (draft lock), by window w or the backend.
Reconcile(w, id) ==
  /\ FixIds /\ ~MutRenderReconcile /\ ~old /\ id \in book
  /\ LET s == Status(id, BackOf(w)) IN
     /\ RDone(s)
     /\ vis' = RVis(vis, id, s) /\ span' = span \ {id} /\ book' = book \ {id}
  /\ UNCHANGED <<typed, nsent, req, wait, appended, rows, ledger, held, dropped, snap, old>>

\* MutRenderReconcile: the window reads, then later writes the whole draft from its read.
ReconRead(w, id) ==
  /\ FixIds /\ MutRenderReconcile /\ ~old /\ id \in book /\ snap[w] = NoSnap
  /\ LET s == Status(id, BackOf(w)) IN
     /\ RDone(s)
     /\ snap' = [snap EXCEPT ![w] = <<RVis(vis, id, s), span \ {id}, book \ {id}>>]
  /\ UNCHANGED <<typed, vis, span, book, nsent, req, wait, appended, rows, ledger, held, dropped, old>>
ReconWrite(w) ==
  /\ snap[w] # NoSnap /\ ~old
  /\ vis' = snap[w][1] /\ span' = snap[w][2] /\ book' = snap[w][3]
  /\ snap' = [snap EXCEPT ![w] = NoSnap]
  /\ UNCHANGED <<typed, nsent, req, wait, appended, rows, ledger, held, dropped, old>>

\* The user gives up on an entry the lookup cannot resolve (unknown): fenced under the history
\* lock if nothing is there yet. Not offered while the id is pending (held, in flight).
Abandon(w, id) ==
  /\ FixIds /\ ~old /\ id \in book /\ ledger[id] = "none" /\ Status(id, BackOf(w)) = "unknown"
  /\ ledger' = [ledger EXCEPT ![id] = "fenced"]
  /\ UNCHANGED <<typed, vis, span, book, nsent, req, wait, appended, rows, held, dropped, snap, old>>

\* The user retries an unresolved entry with the same id and payload. The client cannot see a
\* request still on its way to (or inside) a backend, so only the in-lock check stops a duplicate.
RetrySame(id, b) ==
  /\ FixIds /\ ~old /\ id \in book /\ ~(\E r \in req : r.id = id /\ r.to = b)
  /\ ~(\E h \in held : h[1] = id)
  /\ req' = req \cup {[id |-> id, at |-> "net", to |-> b, kind |-> "send"]}
  /\ UNCHANGED <<typed, vis, span, book, nsent, wait, appended, rows, ledger, held, dropped, snap, old>>

-----------------------------------------------------------------------------
(* Backend                                                                 *)

Register(r) ==
  /\ ~old /\ r \in req /\ r.at = "net"
  /\ req' = (req \ {r}) \cup {[r EXCEPT !.at = r.to]}
  /\ UNCHANGED <<typed, vis, span, book, nsent, wait, appended, rows, ledger, held, dropped, snap, old>>

Done(r) == wait' = wait \ {r.id}

\* Append under the history write lock, after the in-lock id check.
Append(r) ==
  /\ ~old /\ r \in req /\ r.at # "net"
  /\ req' = req \ {r}
  /\ IF FixIds /\ ~MutNoDedupe /\ ledger[r.id] # "none"
       THEN \* already accepted / fenced / in progress: no row
            /\ Done(r)
            \* A held entry whose id is accepted, fenced or dropped is done.
            /\ held' = IF r.kind = "held" THEN held \ {<<r.id, r.at>>} ELSE held
            /\ UNCHANGED <<appended, rows, ledger>>
       ELSE /\ appended' = appended \cup {[id |-> r.id, b |-> r.at, kind |-> r.kind]}
            /\ rows' = Inc(rows, r.id[1])
            /\ ledger' = IF FixIds THEN [ledger EXCEPT ![r.id] = "appended"] ELSE ledger
            /\ UNCHANGED <<wait, held>>
  /\ UNCHANGED <<typed, vis, span, book, nsent, dropped, snap, old>>

\* Refused before the append (dequeue refusal): held, the caller gets Ok (queued).
\* FixIds: the hold path consults the ledger too; an id that already has an entry is answered
\* by Append's check instead (holding it would offer an accepted send again).
Hold(r) ==
  /\ WithHeld /\ ~old /\ r \in req /\ r.at # "net" /\ r.kind = "send"
  /\ ~FixIds \/ ledger[r.id] = "none"
  /\ req' = req \ {r} /\ held' = held \cup {<<r.id, r.at>>} /\ Done(r)
  /\ UNCHANGED <<typed, vis, span, book, nsent, appended, rows, ledger, dropped, snap, old>>

Commit(a) ==
  /\ ~old /\ a \in appended
  /\ appended' = appended \ {a}
  /\ ledger' = IF FixIds THEN [ledger EXCEPT ![a.id] = "accepted"] ELSE ledger
  /\ held' = IF a.kind = "held" THEN held \ {<<a.id, a.b>>} ELSE held
  /\ wait' = wait \ {a.id}
  /\ UNCHANGED <<typed, vis, span, book, nsent, req, rows, dropped, snap, old>>

Rollback(a) ==
  /\ RollbackPossible /\ ~old /\ a \in appended
  /\ appended' = appended \ {a} /\ rows' = [rows EXCEPT ![a.id[1]] = @ - 1]
  \* A rolled-back send is fenced (its text goes back to the draft); a rolled-back held Retry
  \* stays unresolved, because its held entry still owns the text and retries with the same id.
  /\ ledger' = IF FixIds THEN [ledger EXCEPT ![a.id] = IF a.kind = "held" THEN "none" ELSE "fenced"]
                ELSE ledger
  /\ wait' = wait \ {a.id}
  /\ vis' = IF a.id \in wait /\ a.kind = "send" THEN Restore(a.id) ELSE vis
  /\ UNCHANGED <<typed, span, book, nsent, req, held, dropped, snap, old>>

\* H1 / D2 without transport: the refusal cannot roll back; the row stays, the caller gets Err.
ErrDurable(a) ==
  /\ RollbackFail /\ ~old /\ a \in appended
  /\ appended' = appended \ {a}
  /\ ledger' = IF FixIds THEN [ledger EXCEPT ![a.id] = "accepted"] ELSE ledger
  \* FixIds: the caller asks the ledger; accepted, so the held entry goes.
  /\ held' = IF FixIds /\ a.kind = "held" THEN held \ {<<a.id, a.b>>} ELSE held
  /\ wait' = wait \ {a.id}
  /\ vis' = IF a.id \in wait /\ a.kind = "send" THEN Restore(a.id) ELSE vis
  /\ UNCHANGED <<typed, span, book, nsent, req, rows, dropped, snap, old>>

HeldRetry(h) ==
  /\ ~old /\ h \in held /\ ~Busy(h[1])
  /\ req' = req \cup {[id |-> h[1], at |-> h[2], to |-> h[2], kind |-> "held"]}
  /\ UNCHANGED <<typed, vis, span, book, nsent, wait, appended, rows, ledger, held, dropped, snap, old>>

HeldDiscard(h) ==
  /\ ~old /\ h \in held /\ ~Busy(h[1])
  /\ held' = held \ {h} /\ dropped' = dropped \cup {h[1][1]}
  /\ ledger' = IF FixIds /\ ledger[h[1]] = "none" THEN [ledger EXCEPT ![h[1]] = "dropped"] ELSE ledger
  /\ UNCHANGED <<typed, vis, span, book, nsent, req, wait, appended, rows, snap, old>>

\* Restart (crash or quit) of everything; quitting with held input is blocked.
Resolved == [i \in Ids |-> IF FixIds /\ ledger[i] = "appended" THEN "accepted" ELSE ledger[i]]
Restart ==
  /\ WithRestart /\ ~old /\ held = {}
  /\ req' = {} /\ wait' = {} /\ appended' = {} /\ ledger' = Resolved
  /\ snap' = [w \in Windows |-> NoSnap]
  /\ UNCHANGED <<typed, vis, span, book, nsent, rows, held, dropped, old>>

\* Restart into an older build: it keeps `text` (visible + pending block) and drops pendingSends.
Downgrade ==
  /\ WithDowngrade /\ ~old /\ held = {}
  /\ req' = {} /\ wait' = {} /\ appended' = {} /\ ledger' = Resolved
  /\ snap' = [w \in Windows |-> NoSnap]
  /\ vis' = vis \cup Tok(span) /\ span' = {} /\ book' = {} /\ old' = TRUE
  /\ UNCHANGED <<typed, nsent, rows, held, dropped>>

Next ==
  \/ \E m \in Msgs : Type(m)
  \/ \E m \in Msgs, b \in Backends : Send(m, b)
  \/ \E i \in Ids : ReplyLost(i)
  \/ \E w \in Windows, i \in Ids : Reconcile(w, i) \/ ReconRead(w, i) \/ Abandon(w, i)
  \/ \E w \in Windows : ReconWrite(w)
  \/ \E i \in Ids, b \in Backends : RetrySame(i, b)
  \/ \E r \in req : Register(r) \/ Append(r) \/ Hold(r)
  \/ \E a \in appended : Commit(a) \/ Rollback(a) \/ ErrDurable(a)
  \/ \E h \in held : HeldRetry(h) \/ HeldDiscard(h)
  \/ Restart \/ Downgrade

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
Safe == vis \cup Tok(span) \cup (IF MutPendingOnly THEN Tok(book) ELSE {})
        \cup {m \in Msgs : rows[m] > 0} \cup Tok({r.id : r \in req}) \cup Tok({h[1] : h \in held})

\* Text the user typed is never silently lost.
NoSilentLoss == \A m \in typed : m \in Safe \/ m \in dropped

\* Nothing reaches the transcript twice.
NoDup == \A m \in Msgs : rows[m] <= 1

\* Settled: nothing in flight and every pending entry that can be resolved has been.
Settled ==
  /\ req = {} /\ appended = {} /\ wait = {} /\ \A w \in Windows : snap[w] = NoSnap
  /\ \A i \in book, w \in Windows : ~RDone(Status(i, BackOf(w)))

\* The held list hides entries whose id the ledger already resolved.
Offered == Tok({h[1] : h \in {x \in held : ~FixIds \/ ledger[x[1]] \in {"none", "appended"}}})

\* Once settled, a sent token is not offered again (visible draft or held list).
NoResurrection == Settled => \A m \in Msgs : rows[m] > 0 => m \notin vis \cup Offered
=============================================================================
